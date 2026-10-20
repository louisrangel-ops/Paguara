import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import Redis from 'ioredis';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTANCE_LIVEMODE, assertMerchantCanOperate } from '../common/api-key.guard';
import { ApiError } from '../common/errors';
import { REDIS } from '../common/idempotency.interceptor';
import { MerchantsService } from '../merchants/merchants.service';
import { PaymentIntentsService } from '../payment-intents/payment-intents.service';
import { METHOD_NAMES, PAYMENT_METHODS, PaymentMethodType } from '../payment-intents/payment-methods';
import { EVENT_TYPES, WebhooksService } from '../webhooks/webhooks.service';
import { AuthService, DashboardRequest, SessionGuard, assertCanManageAccount, assertSameOriginWrite } from './auth.service';
import { CapabilitiesService } from '../capabilities/capabilities.service';
import { allowedFor, assertModuleActive, methodSettings, parseMethodList } from '../capabilities/capability-state';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database';
import { DashboardService } from './dashboard.service';

/** URL pública del sitio (links de pago, checkout). Sin configurar, la del propio pedido. */
export function baseUrl(req: Request): string {
  return (process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

@Controller('api/dashboard')
export class DashboardAuthController {
  constructor(private readonly auth: AuthService, private readonly merchants: MerchantsService) {}

  @Post('signup')
  async signup(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() b: Record<string, unknown>) {
    assertSameOriginWrite(req);
    const { userId } = await this.auth.signup(b as Parameters<AuthService['signup']>[0], { ip: clientIp(req), userAgent: req.header('user-agent') });
    const s = await this.auth.resolve(await this.auth.startSession(userId, res));
    return sessionView(s!, await this.merchants.get(s!.merchantId));
  }

  @Post('login')
  @HttpCode(200)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() b: { email?: string; password?: string }) {
    assertSameOriginWrite(req);
    const userId = await this.auth.login(b.email ?? '', b.password ?? '', clientIp(req));
    const s = await this.auth.resolve(await this.auth.startSession(userId, res));
    return sessionView(s!, await this.merchants.get(s!.merchantId));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertSameOriginWrite(req);
    await this.auth.endSession(req, res);
    return { ok: true };
  }
}

function sessionView(s: { userId: string; name: string; email: string; role: string }, merchant: unknown) {
  return {
    user: { id: s.userId, name: s.name, email: s.email, role: s.role },
    merchant,
    livemode: INSTANCE_LIVEMODE,
    other_mode_url: process.env.OTHER_MODE_DASHBOARD_URL ?? null,
    event_types: EVENT_TYPES,
  };
}

@Controller('api/dashboard')
@UseGuards(SessionGuard)
export class DashboardController {
  constructor(
    private readonly dash: DashboardService,
    private readonly merchants: MerchantsService,
    private readonly payments: PaymentIntentsService,
    private readonly webhooks: WebhooksService,
    private readonly capabilities: CapabilitiesService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Get('me')
  async me(@Req() req: DashboardRequest) {
    return sessionView(req.session, await this.merchants.get(req.session.merchantId));
  }

  @Put('account')
  account(@Req() req: DashboardRequest, @Body() b: { business_name?: string }) {
    return this.merchants.updateProfile(req.session.merchantId, b.business_name ?? '');
  }

  @Post('account/kyc')
  @HttpCode(200)
  kyc(@Req() req: DashboardRequest, @Body() b: Record<string, unknown>) {
    return this.merchants.submitKyc(req.session.merchantId, b);
  }

  @Get('overview')
  overview(@Req() req: DashboardRequest) {
    return this.dash.overview(req.session.merchantId);
  }

  @Get('payments')
  list(@Req() req: DashboardRequest, @Query() q: Record<string, string>) {
    return this.dash.listPayments(req.session.merchantId, q);
  }

  @Post('payments')
  async create(@Req() req: DashboardRequest, @Body() b: { amount?: unknown; currency?: string; description?: string; expires_in?: number }) {
    await this.assertCanOperate(req.session.merchantId);
    return this.dash.createPayment(req.session.merchantId, b, baseUrl(req));
  }

  @Get('payments/:id')
  detail(@Req() req: DashboardRequest, @Param('id') id: string) {
    return this.dash.paymentDetail(req.session.merchantId, id, baseUrl(req));
  }

  @Post('payments/:id/cancel')
  @HttpCode(200)
  async cancel(@Req() req: DashboardRequest, @Param('id') id: string) {
    await this.payments.cancel(req.session.merchantId, id, 'requested_by_merchant');
    return this.dash.paymentDetail(req.session.merchantId, id, baseUrl(req));
  }

  @Get('balances')
  async balances(@Req() req: DashboardRequest) {
    const [balances, payouts] = await Promise.all([this.dash.balances(req.session.merchantId), this.dash.payouts(req.session.merchantId)]);
    return { balances, payouts };
  }

  @Get('settlement_rules')
  rules(@Req() req: DashboardRequest) {
    return this.dash.settlementRules(req.session.merchantId);
  }

  @Put('settlement_rules/:source')
  saveRules(@Req() req: DashboardRequest, @Param('source') source: string, @Body() b: { rules?: [] }) {
    return this.dash.saveSettlementRules(req.session.merchantId, source, b.rules ?? []);
  }

  // ---- Métodos de pago y módulos ----
  @Get('capabilities')
  async caps(@Req() req: DashboardRequest) {
    return { data: await this.capabilities.list(req.session.merchantId) };
  }

  @Put('capabilities/:key')
  setCap(@Req() req: DashboardRequest, @Param('key') key: string, @Body() b: { enabled?: unknown }) {
    assertCanManageAccount(req.session);
    return this.capabilities.setMerchantEnabled(req.session.merchantId, key, b.enabled, `user:${req.session.userId}`);
  }

  @Post('capabilities/:key/request')
  @HttpCode(200)
  requestCap(@Req() req: DashboardRequest, @Param('key') key: string) {
    assertCanManageAccount(req.session);
    return this.capabilities.request(req.session.merchantId, key, `user:${req.session.userId}`);
  }

  // ---- Links de pago ----
  @Get('payment_links')
  async links(@Req() req: DashboardRequest) {
    return { data: await this.dash.listLinks(req.session.merchantId, baseUrl(req)) };
  }

  @Post('payment_links')
  async createLink(@Req() req: DashboardRequest, @Body() b: { amount?: unknown; currency?: string; description?: string; payment_method_types?: unknown }) {
    await this.assertCanOperate(req.session.merchantId);
    await assertModuleActive(this.pool, req.session.merchantId, 'payment_links');
    return this.dash.createLink(req.session.merchantId, { ...b, payment_method_types: parseMethodList(b.payment_method_types) }, baseUrl(req));
  }

  @Post('payment_links/:id/activate')
  @HttpCode(200)
  async activateLink(@Req() req: DashboardRequest, @Param('id') id: string) {
    await assertModuleActive(this.pool, req.session.merchantId, 'payment_links');
    return this.dash.setLinkActive(req.session.merchantId, id, true, baseUrl(req));
  }

  @Post('payment_links/:id/deactivate')
  @HttpCode(200)
  deactivateLink(@Req() req: DashboardRequest, @Param('id') id: string) {
    return this.dash.setLinkActive(req.session.merchantId, id, false, baseUrl(req));
  }

  // ---- Llaves API ----
  @Get('api_keys')
  async keys(@Req() req: DashboardRequest) {
    return { data: await this.merchants.listApiKeys(req.session.merchantId) };
  }

  @Post('api_keys')
  async createKey(@Req() req: DashboardRequest, @Body() b: { kind?: string }) {
    if (b.kind !== 'secret' && b.kind !== 'publishable') throw new ApiError(400, 'kind_invalid', 'Tipo de llave inválido');
    await this.assertCanOperate(req.session.merchantId);
    return this.merchants.createApiKey(req.session.merchantId, b.kind, INSTANCE_LIVEMODE);
  }

  /** Nueva llave del mismo tipo y revoca la anterior en el mismo paso. */
  @Post('api_keys/:id/roll')
  async rollKey(@Req() req: DashboardRequest, @Param('id') id: string) {
    const key = await this.merchants.apiKeyOwned(req.session.merchantId, id);
    if (!key.is_active) throw new ApiError(409, 'key_revoked', 'Esa llave ya está revocada');
    await this.assertCanOperate(req.session.merchantId);
    const fresh = await this.merchants.createApiKey(req.session.merchantId, key.kind, key.livemode);
    await this.merchants.revokeApiKey(req.session.merchantId, id);
    return fresh;
  }

  @Post('api_keys/:id/revoke')
  @HttpCode(200)
  async revokeKey(@Req() req: DashboardRequest, @Param('id') id: string) {
    await this.merchants.apiKeyOwned(req.session.merchantId, id);
    await this.merchants.revokeApiKey(req.session.merchantId, id);
    return { ok: true };
  }

  // ---- Webhooks y eventos ----
  @Get('webhooks')
  async endpoints(@Req() req: DashboardRequest) {
    return { data: await this.webhooks.listEndpoints(req.session.merchantId) };
  }

  @Post('webhooks')
  createEndpoint(@Req() req: DashboardRequest, @Body() b: { url?: string; enabled_events?: string[] }) {
    return this.webhooks.createEndpoint(req.session.merchantId, b.url ?? '', Array.isArray(b.enabled_events) ? b.enabled_events : []);
  }

  @Post('webhooks/:id/reveal')
  @HttpCode(200)
  reveal(@Req() req: DashboardRequest, @Param('id') id: string) {
    return this.webhooks.revealSecret(req.session.merchantId, id);
  }

  @Post('webhooks/:id/enable')
  @HttpCode(200)
  enableEndpoint(@Req() req: DashboardRequest, @Param('id') id: string) {
    return this.webhooks.setStatus(req.session.merchantId, id, 'enabled');
  }

  @Post('webhooks/:id/disable')
  @HttpCode(200)
  disableEndpoint(@Req() req: DashboardRequest, @Param('id') id: string) {
    return this.webhooks.setStatus(req.session.merchantId, id, 'disabled');
  }

  @Post('webhooks/:id/test')
  @HttpCode(200)
  testEndpoint(@Req() req: DashboardRequest, @Param('id') id: string) {
    return this.webhooks.sendTest(req.session.merchantId, id, INSTANCE_LIVEMODE);
  }

  @Get('events')
  events(@Req() req: DashboardRequest, @Query('limit') limit?: string, @Query('starting_after') after?: string) {
    return this.webhooks.listEvents(req.session.merchantId, Number(limit) || 25, after || undefined);
  }

  @Get('events/:id')
  event(@Req() req: DashboardRequest, @Param('id') id: string) {
    return this.webhooks.getEvent(req.session.merchantId, id);
  }

  @Post('events/:id/resend')
  @HttpCode(200)
  resend(@Req() req: DashboardRequest, @Param('id') id: string) {
    return this.webhooks.resend(req.session.merchantId, id);
  }

  private async assertCanOperate(merchantId: string) {
    const m = await this.merchants.get(merchantId);
    assertMerchantCanOperate(m.status, INSTANCE_LIVEMODE);
  }
}

/** Sin sesión: precios para el sitio público y la entrada de los links de pago. */
@Controller()
export class PublicController {
  constructor(
    private readonly dash: DashboardService,
    private readonly payments: PaymentIntentsService,
    private readonly merchants: MerchantsService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Get('api/public/methods')
  methods() {
    return Object.entries(PAYMENT_METHODS).map(([type, m]) => ({
      type, name: METHOD_NAMES[type as PaymentMethodType], currency: m.chargeCurrency, fee_bps: m.feeBps, fixed_usd: m.feeFixedUsd.toString(),
      tax_bps: m.feeTaxBps, igtf_bps: m.igtfBps,
    }));
  }

  /** Cada visita crea un pago nuevo con el monto del link y manda al checkout. */
  @Get('pay/:slug')
  async pay(@Req() req: Request, @Res() res: Response, @Param('slug') slug: string) {
    const key = `paylink:ip:${clientIp(req)}`;
    const hits = await this.redis.multi().incr(key).expire(key, 60).exec();
    if (Number(hits?.[0]?.[1]) > 30) throw new ApiError(429, 'too_many_requests', 'Demasiados intentos. Espera un minuto.');
    const link = /^[a-zA-Z0-9]{12,40}$/.test(slug) ? await this.dash.findActiveLink(slug) : null;
    if (!link || link.livemode !== INSTANCE_LIVEMODE) throw new ApiError(404, 'resource_missing', 'Este link de pago no existe o ya no está activo');
    const m = await this.merchants.get(link.merchant_id);
    assertMerchantCanOperate(m.status, link.livemode);
    await assertModuleActive(this.pool, link.merchant_id, 'payment_links');
    // Un método del link que el comercio apagó después simplemente no se ofrece
    let only: PaymentMethodType[] | null = null;
    if (link.payment_method_types) {
      const active = new Set(allowedFor(await methodSettings(this.pool, link.merchant_id), null).map((x) => x.type));
      only = link.payment_method_types.filter((t) => active.has(t));
      if (only.length === 0) throw new ApiError(409, 'no_payment_methods_available', 'Este link no tiene métodos de pago disponibles por ahora');
    }
    const pi = await this.payments.create(link.merchant_id, {
      amount: BigInt(link.amount), currency: link.currency, livemode: link.livemode, paymentLinkId: link.id, paymentMethodTypes: only,
      metadata: { description: link.description, payment_link: link.id },
    });
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(303, await this.dash.checkoutUrl('', pi));
  }
}

/** Sitio público, dashboard y documentación: una sola página con rutas por hash. */
@Controller()
export class SitePageController {
  private html: string | null = null;

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  @Header('X-Frame-Options', 'DENY')
  page(): string {
    this.html ??= `<!doctype html><html lang="es"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
      + `<script>window.__SERVER__ = true;</script></head><body>`
      + readFileSync(join(process.cwd(), 'public', 'site.html'), 'utf8')
      + `</body></html>`;
    return this.html;
  }
}
