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

/**
 * Personas distintas que deben aprobar una liquidación antes de que tesorería la
 * vea (sus instrucciones nacen `on_hold`). En producción el arranque exige 2 o más.
 */
export function payoutApprovalsRequired(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PAYOUT_APPROVALS_REQUIRED ?? 2);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

export type OperatorRole = 'master' | 'operator' | 'compliance' | 'operations' | 'treasury' | 'support' | 'auditor';
export interface Operator { id: string; name: string; role: OperatorRole }

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
        if (typeof p === 'string') result.skipped.push({ merchantId: g.merchant_id, reason: p });
        else if (p) result.payouts.push(p);
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
    // Siempre una sola regla: la cuenta en bolívares al 100 % (migración 010)
    const { rows: rules } = await c.query<{ target_currency: Currency; bps: number; destination: Record<string, unknown> }>(
      `SELECT target_currency, bps, destination FROM merchants.settlement_rules
        WHERE merchant_id = $1 AND source_currency = $2`, [merchantId, source]);
    if (rules.length === 0) return null;

    // Re-lee con lock: otro corte concurrente pudo haberlos tomado
    const pis = (await this.repo.lockMany(c, ids)).filter((pi) => pi.status === 'succeeded' && pi.funds_received_entry_id !== null);
    if (pis.length === 0) return null;
    const total = pis.reduce((s, pi) => s + pi.net_amount!, 0n);

    const splits: PayoutSplit[] = [];
    for (const r of rules) {
      if (r.target_currency === source) {
        splits.push({ currency: source, bps: r.bps });
      } else {
        const usdVes = [source, r.target_currency].includes('USD') && [source, r.target_currency].includes('VES');
        splits.push({
          currency: r.target_currency,
          bps: r.bps,
          // USD/VES se liquida exactamente a la tasa oficial BCV, sin spread cambiario.
          spreadBps: usdVes ? 0 : spreadBps,
          quote: await this.fx.freezeQuote(
            c, source, r.target_currency,
            usdVes ? 'BCV' : defaultRateSource(source, r.target_currency),
            60,
          ),
        });
      }
    }

    const payoutId = `po_${randomBytes(10).toString('hex')}`;
    const { draft, legs } = merchantPayoutEntry(`payout:${batchId}:${merchantId}:${source}`, payoutId, merchantId, source, total, splits);
    const entry = await this.ledger.post(c, draft);
    if (!entry.created) throw new ApiError(409, 'payout_already_exists', `Ya existe liquidación de ${merchantId} en este lote`);

    await c.query(
      `INSERT INTO settlements.payouts (id, batch_id, merchant_id, source_currency, source_amount, ledger_entry_id, approvals_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`, [payoutId, batchId, merchantId, source, total.toString(), entry.entryId, payoutApprovalsRequired()]);
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

  /** Liquidaciones esperando aprobación, las más viejas primero (bandeja del panel interno). */
  async pendingApprovals() {
    const { rows } = await this.pool.query(
      `SELECT p.id, p.merchant_id, m.business_name, p.source_currency, p.source_amount::text, p.approvals_required, p.created_at,
              b.batch_code,
              coalesce((SELECT json_agg(json_build_object('operator', o.name, 'at', a.created_at) ORDER BY a.created_at)
                          FROM settlements.payout_approvals a JOIN platform.operators o ON o.id = a.operator_id
                         WHERE a.payout_id = p.id), '[]') AS approvals,
              (SELECT json_agg(json_build_object('currency', i.currency, 'amount', i.amount::text, 'fx_rate', i.fx_rate::text,
                                                 'destination', i.destination) ORDER BY i.id)
                 FROM settlements.payout_instructions i WHERE i.payout_id = p.id) AS instructions
         FROM settlements.payouts p
         JOIN merchants.merchants m ON m.id = p.merchant_id
         JOIN settlements.batches b ON b.id = p.batch_id
        WHERE p.status = 'pending_approval'
        ORDER BY p.created_at, p.id`);
    return rows;
  }

  /**
   * Un operador aprueba una liquidación. Cada persona cuenta una vez; al llegar a
   * las aprobaciones pedidas, la liquidación queda aprobada y sus instrucciones
   * pasan a `pending` (tesorería ya puede pagarlas). La base impone lo mismo.
   */
  approvePayout(payoutId: string, operator: Operator) {
    return withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ status: string; approvals_required: number }>(
        'SELECT status, approvals_required FROM settlements.payouts WHERE id = $1 FOR UPDATE', [payoutId]);
      if (!rows[0]) throw new ApiError(404, 'resource_missing', `No existe la liquidación ${payoutId}`);
      if (rows[0].status === 'approved') throw new ApiError(409, 'payout_already_approved', `${payoutId} ya está aprobada`);
      const ins = await c.query(
        'INSERT INTO settlements.payout_approvals (payout_id, operator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [payoutId, operator.id]);
      if (ins.rowCount === 0) throw new ApiError(409, 'already_approved_by_you', 'Ya aprobaste esta liquidación: falta otra persona');
      const { rows: [{ n }] } = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM settlements.payout_approvals WHERE payout_id = $1', [payoutId]);
      const approved = n >= rows[0].approvals_required;
      if (approved) {
        await c.query(`UPDATE settlements.payouts SET status = 'approved', approved_at = now() WHERE id = $1`, [payoutId]);
        await c.query(`UPDATE settlements.payout_instructions SET status = 'pending', updated_at = now() WHERE payout_id = $1 AND status = 'on_hold'`, [payoutId]);
      }
      this.log.log(`Liquidación ${payoutId}: aprobación ${n}/${rows[0].approvals_required} de ${operator.name}`);
      return { id: payoutId, status: approved ? 'approved' : 'pending_approval', approvals: n, approvals_required: rows[0].approvals_required };
    });
  }
}
