import { Body, CanActivate, Controller, ExecutionContext, HttpCode, Inject, Injectable, Param, Post, UseGuards } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ApiError } from '../common/errors';
import { Currency, isCurrency } from '../common/money';
import { FxService } from '../fx/fx.service';
import { toApi } from '../payment-intents/payment-intent.repository';
import { PaymentIntentsService } from '../payment-intents/payment-intents.service';
import { RailResult } from '../payment-intents/rails/rail-adapter';
import { PayoutLeg } from '../ledger/entry-templates';
import { MerchantsService, MerchantStatus } from '../merchants/merchants.service';
import { SettlementsService } from './settlements.service';
import { Pool } from 'pg';
import { PG_POOL, withTransaction } from '../database/database';
import { LedgerService } from '../ledger/ledger.service';

/** Endpoints para workers internos y el panel administrativo (KYC, conciliación, tesorería). */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_API_TOKEN;
    const got = ctx.switchToHttp().getRequest<Request>().header('x-internal-token') ?? '';
    if (!expected || got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      throw new ApiError(401, 'unauthenticated', 'Token interno inválido');
    }
    return true;
  }
}

function currency(v: string): Currency {
  if (!isCurrency(v)) throw new ApiError(400, 'currency_invalid', `Moneda no soportada: ${v}`);
  return v;
}

@Controller('internal')
@UseGuards(InternalTokenGuard)
export class InternalController {
  constructor(
    private readonly payments: PaymentIntentsService,
    private readonly settlements: SettlementsService,
    private readonly fx: FxService,
    private readonly merchants: MerchantsService,
    private readonly ledger: LedgerService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Tesorería registra capital depositado en sus cuentas (p. ej. USDT en la wallet
   * para pagar la porción en USDT de las liquidaciones). `reference` hace la operación idempotente.
   */
  @Post('treasury/contributions')
  async contribute(@Body() b: { currency: string; amount: string; reference: string }) {
    const c = currency(b.currency);
    if (!/^\d{1,20}$/.test(b.amount ?? '') || BigInt(b.amount) <= 0n) throw new ApiError(400, 'amount_invalid', 'amount debe ser un entero positivo en unidades mínimas');
    if (!b.reference) throw new ApiError(400, 'reference_required', 'Falta reference (comprobante del depósito)');
    const amount = BigInt(b.amount);
    const entry = await withTransaction(this.pool, (client) => this.ledger.post(client, {
      idempotencyKey: `treasury:${b.reference}`, kind: 'capital_contribution', description: `Aporte de capital ${c} (${b.reference})`,
      lines: [
        { accountCode: `platform:cash:${c}`, currency: c, amount },
        { accountCode: `platform:fx_position:${c}`, currency: c, amount: -amount },
      ],
    }));
    return { entry_id: entry.entryId, created: entry.created };
  }

  @Post('merchants')
  async createMerchant(@Body() b: { business_name: string; rif: string; webhook_url?: string }) {
    return this.merchants.create({ businessName: b.business_name, rif: b.rif, webhookUrl: b.webhook_url });
  }

  /** Aprobación o suspensión tras revisión de KYC. */
  @Post('merchants/:id/status')
  @HttpCode(200)
  async setMerchantStatus(@Param('id') id: string, @Body() b: { status: MerchantStatus }) {
    await this.merchants.setStatus(id, b.status);
    return { id, status: b.status };
  }

  /** La llave en claro se devuelve solo aquí; después solo existe su hash. */
  @Post('merchants/:id/api_keys')
  async createApiKey(@Param('id') id: string, @Body() b: { kind: 'secret' | 'publishable'; livemode: boolean }) {
    return this.merchants.createApiKey(id, b.kind, b.livemode === true);
  }

  @Post('merchants/:id/settlement_rules')
  @HttpCode(200)
  async setRules(@Param('id') id: string, @Body() b: { source_currency: string;
    rules: Array<{ target_currency: string; bps: number; destination: Record<string, unknown> }> }) {
    await this.merchants.setSettlementRules(id, currency(b.source_currency),
      b.rules.map((r) => ({ targetCurrency: currency(r.target_currency), bps: r.bps, destination: r.destination })));
    return { ok: true };
  }

  @Post('payment_intents/expire')
  @HttpCode(200)
  async expire() {
    return { canceled: await this.payments.expireStale() };
  }

  @Post('fx/rates')
  async recordRate(@Body() b: { base: string; quote: string; rate: string; source: string; observed_at?: string }) {
    const id = await this.fx.recordRate(currency(b.base), currency(b.quote), b.rate, b.source, b.observed_at ? new Date(b.observed_at) : undefined);
    return { id };
  }

  /** Resultado de un riel: webhook del banco, match de Pago Móvil P2P, confirmaciones on-chain. */
  @Post('payment_intents/:id/rail_result')
  @HttpCode(200)
  async railResult(@Param('id') id: string, @Body() b: { source: string; result: RailResult }) {
    return toApi(await this.payments.applyRailResult(id, b.result, `worker:${b.source}`));
  }

  @Post('rail_batches')
  async railFunds(@Body() b: { batch_id: string; rail: string; currency: string; payment_intent_ids: string[] }) {
    return this.settlements.recordRailFunds(b.batch_id, b.rail, currency(b.currency), b.payment_intent_ids);
  }

  /** Corte de lote de liquidación (lo dispara un cron por moneda y hora de corte). */
  @Post('settlement_batches')
  async cutoff(@Body() b: { batch_code: string; source_currency: string; min_amount?: string; spread_bps?: number }) {
    const r = await this.settlements.runCutoff(b.batch_code, {
      sourceCurrency: currency(b.source_currency),
      minAmount: b.min_amount ? BigInt(b.min_amount) : undefined,
      spreadBps: b.spread_bps,
    });
    const leg = (l: PayoutLeg) => ({ ...l, sourceAmount: l.sourceAmount.toString(), spread: l.spread.toString(), amount: l.amount.toString() });
    return { ...r, payouts: r.payouts.map((p) => ({ ...p, sourceAmount: p.sourceAmount.toString(), legs: p.legs.map(leg) })) };
  }
}
