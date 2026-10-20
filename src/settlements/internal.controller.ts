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
import { AlertsService } from '../alerts/alerts.service';
import { AuthService } from '../dashboard/auth.service';
import { MfaService } from '../mfa/mfa.service';
import { ReconciliationService, yesterdayInCaracas } from '../reconciliation/reconciliation.service';
import { BankMovement, parseDate, parseStatementCsv } from '../reconciliation/statement-parser';
import { RailCredentialsService } from '../secrets/rail-credentials.service';
import { principal as operatorPrincipal } from './internal-auth.controller';

/**
 * Quién llama a /internal: `system` es el token compartido de los workers
 * (INTERNAL_API_TOKEN: tasas, resultados de rieles, cortes, conciliación); una
 * persona entra con la sesión `ops_…` que recibe al poner su token de operador y
 * el código de su app autenticadora (POST /internal/auth/session), y queda en la
 * auditoría con su nombre. El token `opk_…` solo ya no abre nada.
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
    if (got.startsWith('opk_')) {
      throw new ApiError(401, 'operator_session_required', 'Entra por el panel interno con tu token y el código de tu app autenticadora');
    }
    const op = await this.operators.authenticateSession(got);
    if (!op) throw new ApiError(401, 'unauthenticated', 'Token interno inválido o sesión vencida');
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

function requireReason(v: unknown): string {
  const r = typeof v === 'string' ? v.trim() : '';
  if (r.length < 10 || r.length > 300) throw new ApiError(400, 'reason_required', 'Escribe el motivo y cómo verificaste la identidad (10 a 300 caracteres)');
  return r;
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
    private readonly capabilities: CapabilitiesService,
    private readonly operators: OperatorsService,
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly credentials: RailCredentialsService,
    private readonly reconciliation: ReconciliationService,
    private readonly alerts: AlertsService,
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

  /**
   * Una persona perdió el teléfono y sus códigos de respaldo: un maestro (otro, no
   * ella misma) le quita el doble factor y le cierra las sesiones. En su próxima
   * entrada vuelve a inscribirlo. Queda en la auditoría con el motivo.
   */
  @Post('operators/:id/mfa/reset')
  @HttpCode(200)
  async resetOperatorMfa(@Req() req: InternalRequest, @Param('id') id: string, @Body() b: { reason?: string }) {
    const by = master(req);
    if (id === by.id) throw new ApiError(409, 'cannot_reset_self', 'Otro maestro debe reiniciar tu doble factor');
    const reason = requireReason(b.reason);
    const op = await this.operators.get(id);
    await this.mfa.remove(operatorPrincipal(op), `platform:${by.name}`, 'reset', reason);
    await this.operators.endAllSessions(id);
    return { id, mfa_enabled: false };
  }

  /** Buscar a un usuario de un comercio por correo (para soporte: reinicio de doble factor). */
  @Get('dashboard_users')
  async findUser(@Req() req: InternalRequest, @Query('email') email: string) {
    master(req);
    const { rows } = await this.pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.merchant_id, m.business_name, (f.confirmed_at IS NOT NULL) AS mfa_enabled
         FROM dashboard.users u JOIN merchants.merchants m ON m.id = u.merchant_id
         LEFT JOIN security.mfa_factors f ON f.principal_type = 'user' AND f.principal_id = u.id
        WHERE u.email = $1`, [(email ?? '').trim().toLowerCase()]);
    return { object: 'list', data: rows };
  }

  /** Reinicio de doble factor de un usuario del comercio que lo perdió, después de verificar su identidad. */
  @Post('dashboard_users/:id/mfa/reset')
  @HttpCode(200)
  async resetUserMfa(@Req() req: InternalRequest, @Param('id') id: string, @Body() b: { reason?: string }) {
    const by = master(req);
    const reason = requireReason(b.reason);
    await this.mfa.remove({ type: 'user', id, label: '' }, `platform:${by.name}`, 'reset', reason);
    await this.auth.revokeAllSessions(id);
    return { id, mfa_enabled: false };
  }

  // ---- Secretos de los bancos (KMS) ----
  @Get('rail_credentials')
  async listCredentials(@Req() req: InternalRequest) {
    person(req);
    return { object: 'list', data: await this.credentials.list() };
  }

  /** Carga o reemplaza (versión nueva) una llave, clave o certificado de un banco. El valor no se vuelve a mostrar. */
  @Post('rail_credentials')
  putCredential(@Req() req: InternalRequest, @Body() b: { rail?: string; name?: string; kind?: string; value?: string }) {
    master(req);
    return this.credentials.put(b, actorName(req));
  }

  @Post('rail_credentials/:rail/:name/retire')
  @HttpCode(200)
  retireCredential(@Req() req: InternalRequest, @Param('rail') rail: string, @Param('name') name: string) {
    master(req);
    return this.credentials.retire(rail, name, actorName(req));
  }

  // ---- Conciliación y alertas ----
  /**
   * Extracto del banco: `csv` (fecha;referencia;monto;descripcion) o `movements`
   * ya en unidades mínimas. Lo sube el proceso que baja el archivo del banco o una persona.
   */
  @Post('reconciliation/statements')
  importStatement(@Req() req: InternalRequest, @Body() b: { rail?: string; currency?: string; statement_date?: string; csv?: string;
    movements?: Array<{ value_date?: string; amount?: string; reference?: string; description?: string }> }) {
    const cur = currency(String(b.currency ?? ''));
    let movements: BankMovement[];
    try {
      movements = typeof b.csv === 'string' ? parseStatementCsv(b.csv, cur) : (b.movements ?? []).map((m) => {
        if (!/^-?\d{1,20}$/.test(m.amount ?? '') || m.amount === '0') throw new Error('amount debe ser un entero distinto de 0 en unidades mínimas');
        if (!m.reference) throw new Error('falta reference');
        return { valueDate: parseDate(m.value_date ?? ''), amount: BigInt(m.amount!), reference: String(m.reference).slice(0, 80), description: m.description?.slice(0, 300) };
      });
    } catch (e) {
      throw new ApiError(400, 'statement_invalid', (e as Error).message);
    }
    return this.reconciliation.importStatement({ rail: b.rail, currency: cur, statementDate: b.statement_date, source: 'file', movements }, actorName(req));
  }

  @Post('reconciliation/runs')
  runReconciliation(@Req() req: InternalRequest, @Body() b: { rail?: string; currency?: string; date?: string }) {
    return this.reconciliation.run({ rail: b.rail, currency: b.currency, date: b.date }, actorName(req));
  }

  /** El job diario (cron de la mañana): todos los rieles, por defecto el día anterior en Caracas. */
  @Post('reconciliation/daily')
  @HttpCode(200)
  daily(@Req() req: InternalRequest, @Body() b: { date?: string }) {
    return this.reconciliation.runDaily(b.date ?? yesterdayInCaracas(), actorName(req));
  }

  @Get('reconciliation/runs')
  async runs(@Req() req: InternalRequest, @Query('limit') limit?: string) {
    person(req);
    return { object: 'list', data: await this.reconciliation.listRuns(Number(limit ?? 50) || 50) };
  }

  @Get('reconciliation/runs/:id')
  run(@Req() req: InternalRequest, @Param('id') id: string) {
    person(req);
    return this.reconciliation.getRun(id);
  }

  @Get('reconciliation/discrepancies')
  async discrepancies(@Req() req: InternalRequest) {
    person(req);
    return { object: 'list', data: await this.reconciliation.openDiscrepancies() };
  }

  @Post('reconciliation/discrepancies/:id/resolve')
  @HttpCode(200)
  resolveDiscrepancy(@Req() req: InternalRequest, @Param('id') id: string, @Body() b: { resolution?: string }) {
    person(req);
    return this.reconciliation.resolve(id, actorName(req), b.resolution);
  }

  @Get('alerts')
  async listAlerts(@Req() req: InternalRequest) {
    person(req);
    return { object: 'list', data: await this.alerts.open() };
  }

  @Post('alerts/:id/acknowledge')
  @HttpCode(200)
  ackAlert(@Req() req: InternalRequest, @Param('id') id: string) {
    person(req);
    return this.alerts.acknowledge(id, actorName(req));
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
  async recordRate(@Req() req: InternalRequest, @Body() b: { base: string; quote: string; rate: string; source: string; observed_at?: string }) {
    workerOr(req, 'workers:run');
    const id = await this.fx.recordRate(currency(b.base), currency(b.quote), b.rate, b.source, b.observed_at ? new Date(b.observed_at) : undefined);
    return { id };
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
