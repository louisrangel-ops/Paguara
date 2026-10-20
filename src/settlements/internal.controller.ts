import { Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Inject, Injectable, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
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
import { Operator, OperatorRole, SettlementsService } from './settlements.service';
import { hasOperatorPermission, operatorPermissions, OperatorPermission, OperatorsService } from './operators.service';
import { Pool } from 'pg';
import { PG_POOL, withTransaction } from '../database/database';
import { LedgerService } from '../ledger/ledger.service';
import { CapabilitiesService, PlatformMerchantPatch } from '../capabilities/capabilities.service';

/**
 * Quién llama a /internal: `system` es el token compartido de los workers
 * (INTERNAL_API_TOKEN: tasas, resultados de rieles, cortes); una persona entra
 * con su token de operador (`opk_…`) y queda en la auditoría con su nombre.
 */
export type InternalActor = { kind: 'system' } | ({ kind: 'operator' } & Operator);
type InternalRequest = Request & { internalActor: InternalActor };

@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly operators: OperatorsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<InternalRequest>();
    const got = req.header('x-internal-token') ?? '';
    const expected = process.env.INTERNAL_API_TOKEN;
    if (expected && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      req.internalActor = { kind: 'system' };
      return true;
    }
    const op = await this.operators.authenticate(got);
    if (!op) throw new ApiError(401, 'unauthenticated', 'Token interno inválido');
    req.internalActor = { kind: 'operator', ...op };
    return true;
  }
}

function person(req: InternalRequest): Operator {
  const a = req.internalActor;
  if (a.kind !== 'operator') throw new ApiError(403, 'insufficient_role', 'Esta acción requiere un operador humano');
  return a;
}

function permitted(req: InternalRequest, permission: OperatorPermission): Operator {
  const op = person(req);
  if (!hasOperatorPermission(op, permission)) throw new ApiError(403, 'insufficient_role', `Tu rol no tiene el permiso ${permission}`);
  return op;
}

function workerOr(req: InternalRequest, permission: OperatorPermission): Operator | null {
  if (req.internalActor.kind === 'system') return null;
  return permitted(req, permission);
}

const actorName = (req: InternalRequest) => (req.internalActor.kind === 'operator' ? `platform:${req.internalActor.name}` : 'platform:system');

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
    private readonly capabilities: CapabilitiesService,
    private readonly operators: OperatorsService,
  ) {}

  /** Quién soy (el panel interno lo usa al entrar). */
  @Get('whoami')
  whoami(@Req() req: InternalRequest) {
    const a = req.internalActor;
    return a.kind === 'operator' ? { kind: a.kind, id: a.id, name: a.name, role: a.role, permissions: operatorPermissions(a.role) } : { kind: 'system' };
  }

  @Get('operators')
  async listOperators(@Req() req: InternalRequest) {
    permitted(req, 'operators:read');
    return { object: 'list', data: await this.operators.list() };
  }

  /** Con el token de sistema, solo el primer maestro; después los crea un maestro. El token se ve una vez. */
  @Post('operators')
  createOperator(@Req() req: InternalRequest, @Body() b: { name?: string; role?: string }) {
    return this.operators.create(b, req.internalActor.kind === 'system' ? 'system' : req.internalActor);
  }

  @Post('operators/:id/role')
  @HttpCode(200)
  changeOperatorRole(@Req() req: InternalRequest, @Param('id') id: string, @Body() b: { role?: OperatorRole }) {
    return this.operators.changeRole(id, b.role as OperatorRole, permitted(req, 'operators:manage'));
  }

  @Post('operators/:id/revoke')
  @HttpCode(200)
  revokeOperator(@Req() req: InternalRequest, @Param('id') id: string) {
    return this.operators.revoke(id, permitted(req, 'operators:manage'));
  }

  /** Liquidaciones esperando aprobación. */
  @Get('payouts/pending')
  async pendingPayouts(@Req() req: InternalRequest) {
    permitted(req, 'payouts:read');
    return { object: 'list', data: await this.settlements.pendingApprovals() };
  }

  /** Cada persona aprueba una vez; con las aprobaciones pedidas, tesorería puede pagar. */
  @Post('payouts/:id/approve')
  @HttpCode(200)
  approvePayout(@Req() req: InternalRequest, @Param('id') id: string) {
    return this.settlements.approvePayout(id, permitted(req, 'payouts:approve'));
  }

  /**
   * Tesorería registra capital depositado en sus cuentas (p. ej. USDT en la wallet
   * para pagar la porción en USDT de las liquidaciones). `reference` hace la operación idempotente.
   */
  @Post('treasury/contributions')
  async contribute(@Req() req: InternalRequest, @Body() b: { currency: string; amount: string; reference: string }) {
    permitted(req, 'treasury:contribute');
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
  async createMerchant(@Req() req: InternalRequest, @Body() b: { business_name: string; rif: string; webhook_url?: string }) {
    permitted(req, 'merchants:manage');
    return this.merchants.create({ businessName: b.business_name, rif: b.rif, webhookUrl: b.webhook_url });
  }

  @Get('merchants')
  async listMerchants(@Req() req: InternalRequest, @Query('q') q = '', @Query('status') status = '', @Query('limit') limit = '50') {
    permitted(req, 'merchants:read');
    return { object: 'list', data: await this.merchants.listForAdmin(q, status, Number(limit)) };
  }

  /** Detalle completo para cumplimiento: KYC + perfil ISO 8583 provisionado. */
  @Get('merchants/:id')
  async merchantForReview(@Req() req: InternalRequest, @Param('id') id: string) {
    permitted(req, 'merchants:read');
    return this.merchants.getForReview(id);
  }

  /** MID/TID/MCC y parámetros ISO 8583 asignados por el adquirente; solo maestro. */
  @Post('merchants/:id/iso8583_profile')
  @HttpCode(200)
  setIso8583Profile(@Req() req: InternalRequest, @Param('id') id: string, @Body() b: Record<string, unknown>) {
    permitted(req, 'iso8583:manage');
    return this.merchants.setIso8583Profile(id, b);
  }

  /** Aprobación o suspensión tras revisión de KYC. */
  @Post('merchants/:id/status')
  @HttpCode(200)
  async setMerchantStatus(@Req() req: InternalRequest, @Param('id') id: string, @Body() b: { status: MerchantStatus }) {
    permitted(req, 'merchants:status');
    await this.merchants.setStatus(id, b.status);
    return { id, status: b.status };
  }

  /** La llave en claro se devuelve solo aquí; después solo existe su hash. */
  @Post('merchants/:id/api_keys')
  async createApiKey(@Req() req: InternalRequest, @Param('id') id: string, @Body() b: { kind: 'secret' | 'publishable'; livemode: boolean }) {
    permitted(req, 'merchants:api_keys');
    return this.merchants.createApiKey(id, b.kind, b.livemode === true);
  }

  @Post('merchants/:id/settlement_rules')
  @HttpCode(200)
  async setRules(@Req() req: InternalRequest, @Param('id') id: string, @Body() b: { source_currency: string;
    rules: Array<{ target_currency: string; bps: number; destination: Record<string, unknown> }> }) {
    permitted(req, 'settlement:manage');
    await this.merchants.setSettlementRules(id, currency(b.source_currency),
      b.rules.map((r) => ({ targetCurrency: currency(r.target_currency), bps: r.bps, destination: r.destination })));
    return { ok: true };
  }

  @Get('capabilities')
  async globalCapabilities(@Req() req: InternalRequest) {
    permitted(req, 'capabilities:read');
    return { object: 'list', data: await this.capabilities.listGlobal() };
  }

  /** Solicitudes de los comercios esperando aprobación (bandeja del panel interno). */
  @Get('capability_requests')
  async capabilityRequests(@Req() req: InternalRequest) {
    permitted(req, 'capabilities:read');
    return { object: 'list', data: await this.capabilities.pendingRequests() };
  }

  /** Interruptor global de un método o módulo (riel caído, banco sin convenio) y si se da a comercios nuevos. */
  @Post('capabilities/:key')
  @HttpCode(200)
  setGlobalCapability(@Req() req: InternalRequest, @Param('key') key: string, @Body() b: { global_enabled?: boolean; default_for_new?: boolean }) {
    permitted(req, 'platform:manage');
    return this.capabilities.platformSetGlobal(key, b, actorName(req));
  }

  @Get('merchants/:id/capabilities')
  async merchantCapabilities(@Req() req: InternalRequest, @Param('id') id: string) {
    permitted(req, 'capabilities:read');
    await this.merchants.get(id);
    return { object: 'list', data: await this.capabilities.list(id) };
  }

  /** Habilitar (con contrato) o bloquear un método/módulo a un comercio, o fijarle precio y límites negociados. */
  @Post('merchants/:id/capabilities/:key')
  @HttpCode(200)
  setMerchantCapability(@Req() req: InternalRequest, @Param('id') id: string, @Param('key') key: string, @Body() b: PlatformMerchantPatch) {
    permitted(req, 'capabilities:manage');
    return this.capabilities.platformSetForMerchant(id, key, b, actorName(req));
  }

  @Post('payment_intents/expire')
  @HttpCode(200)
  async expire(@Req() req: InternalRequest) {
    workerOr(req, 'workers:run');
    return { canceled: await this.payments.expireStale() };
  }

  @Post('fx/rates')
  async recordRate(@Req() req: InternalRequest, @Body() b: { base: string; quote: string; rate: string; source: string; observed_at?: string; effective_date?: string }) {
    workerOr(req, 'workers:run');
    if (b.source === 'BCV' && !/^\d{4}-\d{2}-\d{2}$/.test(b.effective_date ?? '')) {
      throw new ApiError(400, 'effective_date_required', 'La tasa BCV requiere effective_date YYYY-MM-DD', 'invalid_request_error', { param: 'effective_date' });
    }
    const id = await this.fx.recordRate(
      currency(b.base), currency(b.quote), b.rate, b.source,
      b.observed_at ? new Date(b.observed_at) : new Date(),
      b.effective_date,
    );
    return { id, source: b.source, effective_date: b.effective_date ?? null };
  }

  /** Resultado de un riel: webhook del banco, match de Pago Móvil P2P, confirmaciones on-chain. */
  @Post('payment_intents/:id/rail_result')
  @HttpCode(200)
  async railResult(@Req() req: InternalRequest, @Param('id') id: string, @Body() b: { source: string; result: RailResult }) {
    workerOr(req, 'workers:run');
    return toApi(await this.payments.applyRailResult(id, b.result, `worker:${b.source}`));
  }

  @Post('rail_batches')
  async railFunds(@Req() req: InternalRequest, @Body() b: { batch_id: string; rail: string; currency: string; payment_intent_ids: string[] }) {
    workerOr(req, 'workers:run');
    return this.settlements.recordRailFunds(b.batch_id, b.rail, currency(b.currency), b.payment_intent_ids);
  }

  /** Corte de lote de liquidación (lo dispara un cron por moneda y hora de corte). */
  @Post('settlement_batches')
  async cutoff(@Req() req: InternalRequest, @Body() b: { batch_code: string; source_currency: string; min_amount?: string; spread_bps?: number }) {
    workerOr(req, 'workers:run');
    const r = await this.settlements.runCutoff(b.batch_code, {
      sourceCurrency: currency(b.source_currency),
      minAmount: b.min_amount ? BigInt(b.min_amount) : undefined,
      spreadBps: b.spread_bps,
    });
    const leg = (l: PayoutLeg) => ({ ...l, sourceAmount: l.sourceAmount.toString(), spread: l.spread.toString(), amount: l.amount.toString() });
    return { ...r, payouts: r.payouts.map((p) => ({ ...p, sourceAmount: p.sourceAmount.toString(), legs: p.legs.map(leg) })) };
  }
}
