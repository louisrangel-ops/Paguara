import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { ApiError } from '../common/errors';
import { Currency } from '../common/money';
import { PG_POOL, withTransaction } from '../database/database';
import { FxService } from '../fx/fx.service';
import { merchantPayoutEntry, PayoutLeg, PayoutSplit, railFundsReceivedEntry } from '../ledger/entry-templates';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentIntentRepository } from '../payment-intents/payment-intent.repository';
import { defaultRateSource } from '../payment-intents/payment-methods';
import { INSTANCE_LIVEMODE } from '../common/api-key.guard';
import { enqueueEvent } from '../webhooks/webhooks.service';

/** Spread cambiario por defecto al convertir liquidaciones (120 bps = 1,2 %, el colchón de la guía). */
export const DEFAULT_PAYOUT_SPREAD_BPS = Number(process.env.FX_PAYOUT_SPREAD_BPS ?? 120);

export interface CutoffOptions {
  sourceCurrency: Currency;
  /** No se liquida a comercios con menos de este neto (unidades mínimas): evita transferencias de céntimos. */
  minAmount?: bigint;
  spreadBps?: number;
}

export interface CutoffResult {
  batchId: string;
  payouts: Array<{ payoutId: string; merchantId: string; sourceAmount: bigint; legs: PayoutLeg[] }>;
  skipped: Array<{ merchantId: string; reason: string }>;
}

@Injectable()
export class SettlementsService {
  private readonly log = new Logger(SettlementsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repo: PaymentIntentRepository,
    private readonly ledger: LedgerService,
    private readonly fx: FxService,
  ) {}

  /**
   * Conciliación: el banco/riel acreditó un lote (archivo de cierre, API de
   * movimientos). Mueve el neto de cada comercio de "por recibir" a "disponible".
   */
  recordRailFunds(batchId: string, rail: string, currency: Currency, paymentIntentIds: string[]) {
    return withTransaction(this.pool, async (c) => {
      const pis = await this.repo.lockMany(c, [...new Set(paymentIntentIds)]);
      for (const pi of pis) {
        if (pi.capture_entry_id === null) throw new ApiError(409, 'payment_not_captured', `${pi.id} no está cobrado`);
        if (pi.rail !== rail || pi.charge_currency !== currency) {
          throw new ApiError(409, 'batch_mismatch', `${pi.id} es de ${pi.rail}/${pi.charge_currency}, no de ${rail}/${currency}`);
        }
        if (pi.funds_received_entry_id !== null) {
          throw new ApiError(409, 'funds_already_received', `${pi.id} ya fue conciliado en otro lote`);
        }
      }
      const entry = await this.ledger.post(c, railFundsReceivedEntry(batchId, rail, currency, pis.map((pi) => ({
        merchantId: pi.merchant_id, chargeAmount: pi.charge_amount!, netAmount: pi.net_amount!,
      }))));
      await c.query(
        'UPDATE payments.payment_intents SET funds_received_entry_id = $1 WHERE id = ANY($2)',
        [entry.entryId, pis.map((p) => p.id)],
      );
      return entry;
    });
  }

  /**
   * Corte de lote: toma, por comercio, los intents cobrados con fondos ya
   * recibidos en `sourceCurrency`, aplica la regla de split del comercio y deja
   * instrucciones de pago para tesorería. Cada comercio va en su propia
   * transacción: un error en uno no detiene al resto. Repetir el mismo
   * batch_code no liquida dos veces (los intents ya quedaron en `settled`).
   */
  async runCutoff(batchCode: string, opts: CutoffOptions): Promise<CutoffResult> {
    const batch = await this.pool.query<{ id: string }>(
      `INSERT INTO settlements.batches (id, batch_code) VALUES ($1, $2)
       ON CONFLICT (batch_code) DO UPDATE SET batch_code = EXCLUDED.batch_code RETURNING id`,
      [`stb_${randomBytes(10).toString('hex')}`, batchCode],
    );
    const batchId = batch.rows[0].id;

    const { rows: groups } = await this.pool.query<{ merchant_id: string; ids: string[]; total: bigint }>(
      `SELECT merchant_id, array_agg(id ORDER BY id) AS ids, sum(net_amount)::bigint AS total
         FROM payments.payment_intents
        WHERE status = 'succeeded' AND funds_received_entry_id IS NOT NULL AND charge_currency = $1
        GROUP BY merchant_id ORDER BY merchant_id`,
      [opts.sourceCurrency],
    );

    const result: CutoffResult = { batchId, payouts: [], skipped: [] };
    for (const g of groups) {
      if (g.total < (opts.minAmount ?? 0n)) {
        result.skipped.push({ merchantId: g.merchant_id, reason: 'below_minimum' });
        continue;
      }
      try {
        const p = await withTransaction(this.pool, (c) =>
          this.settleMerchant(c, batchId, g.merchant_id, g.ids, opts.sourceCurrency, opts.spreadBps ?? DEFAULT_PAYOUT_SPREAD_BPS));
        if (p) result.payouts.push(p);
        else result.skipped.push({ merchantId: g.merchant_id, reason: 'no_settlement_rule' });
      } catch (err) {
        this.log.error(`Corte ${batchCode}: no se pudo liquidar a ${g.merchant_id}: ${(err as Error).message}`);
        result.skipped.push({ merchantId: g.merchant_id, reason: (err as { code?: string }).code ?? 'error' });
      }
    }
    await this.pool.query(`UPDATE settlements.batches SET status = 'closed', closed_at = now() WHERE id = $1`, [batchId]);
    return result;
  }

  private async settleMerchant(c: PoolClient, batchId: string, merchantId: string, ids: string[], source: Currency, spreadBps: number) {
    // La porción en moneda origen va de última: absorbe el céntimo de redondeo sin convertirlo
    const { rows: rules } = await c.query<{ target_currency: Currency; bps: number; destination: Record<string, unknown> }>(
      `SELECT target_currency, bps, destination FROM merchants.settlement_rules
        WHERE merchant_id = $1 AND source_currency = $2
        ORDER BY target_currency = $2, target_currency`, [merchantId, source]);
    if (rules.length === 0) return null;

    // Re-lee con lock: otro corte concurrente pudo haberlos tomado
    const pis = (await this.repo.lockMany(c, ids)).filter((pi) => pi.status === 'succeeded' && pi.funds_received_entry_id !== null);
    if (pis.length === 0) return null;
    const total = pis.reduce((s, pi) => s + pi.net_amount!, 0n);

    const splits: PayoutSplit[] = [];
    for (const r of rules) {
      splits.push(r.target_currency === source
        ? { currency: source, bps: r.bps }
        : { currency: r.target_currency, bps: r.bps, spreadBps,
            quote: await this.fx.freezeQuote(c, source, r.target_currency, defaultRateSource(source, r.target_currency), 60) });
    }

    const payoutId = `po_${randomBytes(10).toString('hex')}`;
    const { draft, legs } = merchantPayoutEntry(`payout:${batchId}:${merchantId}:${source}`, payoutId, merchantId, source, total, splits);
    const entry = await this.ledger.post(c, draft);
    if (!entry.created) throw new ApiError(409, 'payout_already_exists', `Ya existe liquidación de ${merchantId} en este lote`);

    await c.query(
      `INSERT INTO settlements.payouts (id, batch_id, merchant_id, source_currency, source_amount, ledger_entry_id)
       VALUES ($1, $2, $3, $4, $5, $6)`, [payoutId, batchId, merchantId, source, total.toString(), entry.entryId]);
    for (const leg of legs) {
      const rule = rules.find((r) => r.target_currency === leg.currency)!;
      await c.query(
        `INSERT INTO settlements.payout_instructions (payout_id, currency, amount, fx_rate, fx_spread_bps, destination)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [payoutId, leg.currency, leg.amount.toString(), leg.rate, leg.spreadBps, JSON.stringify(rule.destination)]);
    }
    for (const pi of pis) {
      await this.repo.transition(c, pi, 'settle', { settlement_entry_id: entry.entryId, settled_at: new Date() },
        { actor: 'settlement', ledgerEntryId: entry.entryId, details: { payout_id: payoutId, batch_id: batchId } });
    }
    await enqueueEvent(c, { merchantId, livemode: INSTANCE_LIVEMODE, type: 'payout.created', objectId: payoutId, object: {
      id: payoutId, object: 'payout', source_currency: source, source_amount: total.toString(), payment_intents: pis.map((p) => p.id),
      legs: legs.map((l) => ({ currency: l.currency, amount: l.amount.toString(), rate: l.rate, spread_bps: l.spreadBps })),
    } });
    return { payoutId, merchantId, sourceAmount: total, legs };
  }
}
