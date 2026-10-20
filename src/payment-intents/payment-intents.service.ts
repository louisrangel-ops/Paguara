import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { ApiError } from '../common/errors';
import { Currency, isCurrency } from '../common/money';
import { PG_POOL, withTransaction } from '../database/database';
import { convertWithQuote, FrozenQuote } from '../fx/fx.math';
import { FxService } from '../fx/fx.service';
import { paymentCaptureEntry } from '../ledger/entry-templates';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentIntentRepository, PaymentIntentRow } from './payment-intent.repository';
import { METHOD_NAMES, PaymentMethodType, defaultRateSource } from './payment-methods';
import { computeBreakdown } from './pricing';
import { MethodSettings, STATE_TEXT, allowedFor, methodSettings } from '../capabilities/capability-state';
import { RAIL_ADAPTERS, RailAdapter, RailResult } from './rails/rail-adapter';

export interface CreatePaymentIntentInput {
  amount: bigint;
  currency: Currency;
  metadata?: Record<string, unknown>;
  customer?: Record<string, unknown>;
  idempotencyKey?: string;
  livemode?: boolean;
  /** Vence si nadie lo confirma (link de WhatsApp abandonado). Por defecto 24 h. */
  expiresInSeconds?: number;
  /** Pago creado al abrir un link de pago. */
  paymentLinkId?: string;
  /** Solo estos métodos (cada uno debe estar activo en el comercio). Sin lista: todos los activos. */
  paymentMethodTypes?: PaymentMethodType[] | null;
  /** A dónde vuelve el pagador al terminar en el checkout (tiendas en línea). Ver parseReturnUrl. */
  returnUrl?: string | null;
}

/**
 * Valida la URL de retorno del checkout: https (http solo en pruebas, para tiendas
 * locales), sin usuario ni clave y de máximo 2048 caracteres.
 */
export function parseReturnUrl(value: unknown, livemode: boolean): string | null {
  if (value === undefined || value === null || value === '') return null;
  const bad = (why: string) => new ApiError(400, 'return_url_invalid', `return_url inválida: ${why}`, 'invalid_request_error', { param: 'return_url' });
  if (typeof value !== 'string' || value.length > 2048) throw bad('debe ser un texto de hasta 2048 caracteres');
  let url: URL;
  try { url = new URL(value); } catch { throw bad('no es una URL absoluta'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !livemode)) throw bad('debe usar https');
  if (url.username || url.password) throw bad('no puede llevar usuario ni clave');
  return url.toString();
}

@Injectable()
export class PaymentIntentsService {
  private readonly log = new Logger(PaymentIntentsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repo: PaymentIntentRepository,
    private readonly ledger: LedgerService,
    private readonly fx: FxService,
    @Inject(RAIL_ADAPTERS) private readonly rails: Map<string, RailAdapter>,
  ) {}

  create(merchantId: string, input: CreatePaymentIntentInput): Promise<PaymentIntentRow> {
    if (input.amount <= 0n) throw new ApiError(400, 'amount_invalid', 'El monto debe ser mayor que cero');
    if (!isCurrency(input.currency)) throw new ApiError(400, 'currency_invalid', `Moneda no soportada: ${input.currency}`);
    const ttl = input.expiresInSeconds ?? 24 * 3600;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 30 * 24 * 3600) {
      throw new ApiError(400, 'expires_invalid', 'El vencimiento debe estar entre 1 minuto y 30 días');
    }
    const id = `pi_${randomBytes(12).toString('hex')}`;
    const only = input.paymentMethodTypes ?? null;
    return withTransaction(this.pool, async (c) => {
      const methods = await methodSettings(c, merchantId);
      if (only) {
        const off = methods.find((m) => only.includes(m.type) && m.state !== 'active');
        if (off) {
          throw new ApiError(400, 'payment_method_not_allowed', `${METHOD_NAMES[off.type]} no está activo en tu cuenta (${STATE_TEXT[off.state]})`,
            'invalid_request_error', { param: 'payment_method_types', payment_method_type: off.type, state: off.state });
        }
      } else if (allowedFor(methods, null).length === 0) {
        throw new ApiError(400, 'no_payment_methods_available', 'Tu cuenta no tiene ningún método de pago activo', 'invalid_request_error');
      }
      const { pi, created } = await this.repo.insert(c, {
        id, merchantId, amount: input.amount, currency: input.currency, metadata: input.metadata ?? {},
        livemode: input.livemode ?? false, idempotencyKey: input.idempotencyKey ?? null,
        clientSecret: `${id}_secret_${randomBytes(16).toString('hex')}`, customer: input.customer ?? null, ttlSeconds: ttl,
        paymentLinkId: input.paymentLinkId ?? null, paymentMethodTypes: only, returnUrl: input.returnUrl ?? null,
      }, input.paymentLinkId ? `payment_link:${input.paymentLinkId}` : `merchant:${merchantId}`);
      if (!created && (pi.amount !== input.amount || pi.currency !== input.currency)) {
        throw new ApiError(422, 'idempotency_key_reused', 'Esta Idempotency-Key ya creó un pago con otro monto o moneda', 'idempotency_error');
      }
      return pi;
    });
  }

  /**
   * Checkout: el navegador solo tiene la llave publicable y el client_secret.
   * Devuelve el intent si ambos corresponden; si no, "no existe" (no se revela nada).
   */
  async authorizeCheckout(merchantId: string, id: string, clientSecret: string): Promise<PaymentIntentRow> {
    const pi = await withTransaction(this.pool, (c) => this.repo.find(c, id));
    const ok = pi !== null && pi.merchant_id === merchantId
      && pi.client_secret.length === clientSecret.length
      && timingSafeEqual(Buffer.from(pi.client_secret), Buffer.from(clientSecret));
    if (!ok) throw new ApiError(404, 'resource_missing', `No existe el PaymentIntent ${id}`);
    return pi!;
  }

  /**
   * Cancela los intents vencidos que aún no movieron dinero. Los que esperan una
   * transferencia (requires_action) no se tocan aquí: el pagador pudo haber
   * enviado el dinero, y es el worker de cada riel quien decide cuándo expiran.
   */
  async expireStale(limit = 500): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM payments.payment_intents
        WHERE expires_at <= now() AND status IN ('requires_payment_method', 'requires_confirmation')
        ORDER BY expires_at LIMIT $1`, [limit]);
    let n = 0;
    for (const { id } of rows) {
      await withTransaction(this.pool, async (c) => {
        const pi = await this.repo.lock(c, id);
        if (pi.status !== 'requires_payment_method' && pi.status !== 'requires_confirmation') return;
        await this.repo.transition(c, pi, 'cancel', { cancellation_reason: 'expired', canceled_at: new Date(), next_action: null },
          { actor: 'system:expiry' });
        n++;
      });
    }
    return n;
  }

  async retrieve(merchantId: string, id: string): Promise<PaymentIntentRow> {
    return withTransaction(this.pool, async (c) => {
      const pi = await this.repo.find(c, id);
      if (!pi || pi.merchant_id !== merchantId) throw new ApiError(404, 'resource_missing', `No existe el PaymentIntent ${id}`);
      return pi;
    });
  }

  /**
   * Elige método de pago: fija riel y moneda de cobro, cotiza y congela la tasa
   * (con vencimiento) y calcula comisión, IVA y neto. Puede repetirse para
   * cambiar de método o renovar una cotización vencida mientras no se confirme.
   */
  attachPaymentMethod(merchantId: string, id: string, type: PaymentMethodType, fxSource?: string): Promise<PaymentIntentRow> {
    return withTransaction(this.pool, async (c) => {
      const pi = await this.repo.lock(c, id, merchantId);
      await this.assertNotExpired(c, pi);
      const settings = await this.assertMethodUsable(c, pi, type);
      const cfg = settings.cfg;
      const chargeCurrency = cfg.chargeCurrency;

      let quote: FrozenQuote | null = null;
      let chargeAmount = pi.amount;
      if (pi.currency !== chargeCurrency) {
        quote = await this.fx.freezeQuote(c, pi.currency, chargeCurrency,
          fxSource ?? defaultRateSource(pi.currency, chargeCurrency), cfg.quoteTtlSeconds);
        chargeAmount = convertWithQuote(pi.amount, pi.currency, chargeCurrency, quote);
      }

      if ((settings.minAmount !== null && chargeAmount < settings.minAmount) || (settings.maxAmount !== null && chargeAmount > settings.maxAmount)) {
        throw new ApiError(400, 'amount_out_of_range', `El monto no está dentro de los límites de ${METHOD_NAMES[type]} para este comercio`,
          'invalid_request_error', { min_amount: settings.minAmount?.toString() ?? null, max_amount: settings.maxAmount?.toString() ?? null, currency: chargeCurrency });
      }

      const { amount: fixedFee, quoteId: feeQuoteId } = await this.fixedFeeIn(c, cfg.feeFixedUsd, chargeCurrency, quote, cfg.quoteTtlSeconds);
      const b = computeBreakdown(chargeAmount, cfg, fixedFee);

      return this.repo.transition(c, pi, 'attach_payment_method', {
        payment_method_type: type,
        rail: cfg.rail,
        charge_currency: chargeCurrency,
        charge_amount: b.charge,
        fx_quote_id: quote?.id ?? null,
        fx_rate: quote?.rate ?? null,
        fx_rate_source: quote?.source ?? null,
        fx_quote_expires_at: quote?.expiresAt ?? null,
        fee_amount: b.fee,
        tax_amount: b.tax,
        net_amount: b.net,
        igtf_amount: b.igtf,
        next_action: null,
        last_payment_error: null,
      }, { actor: `merchant:${merchantId}`, details: { fee_fx_quote_id: feeQuoteId } });
    });
  }

  /**
   * Confirma: en una transacción corta valida la cotización y persiste
   * `processing` (desde aquí la tasa queda congelada en BD). La llamada al riel
   * ocurre FUERA de la transacción, nunca con locks abiertos.
   */
  async confirm(merchantId: string, id: string, paymentMethodDetails: Record<string, unknown>): Promise<PaymentIntentRow> {
    const pi = await withTransaction(this.pool, async (c) => {
      const current = await this.repo.lock(c, id, merchantId);
      await this.assertNotExpired(c, current);
      // El comercio pudo apagar el método entre attach y confirm; lo que ya está en curso no se toca
      if (current.status === 'requires_confirmation') await this.assertMethodUsable(c, current, current.payment_method_type!);
      if (current.status === 'requires_confirmation' && current.fx_quote_id) {
        const { rows } = await c.query<{ expired: boolean }>('SELECT $1::timestamptz <= now() AS expired', [current.fx_quote_expires_at]);
        if (rows[0].expired) {
          throw new ApiError(409, 'fx_quote_expired',
            'La tasa cotizada venció. Vuelve a adjuntar el método de pago para mostrar el nuevo monto.', 'payment_error');
        }
      }
      return this.repo.transition(c, current, 'confirm', { processing_at: new Date() }, { actor: `merchant:${merchantId}` });
    });

    const rail = this.rails.get(pi.rail!);
    if (!rail) throw new ApiError(500, 'rail_unavailable', `Riel ${pi.rail} no configurado`, 'api_error');

    let result: RailResult;
    try {
      result = await rail.charge({
        paymentIntentId: pi.id,
        attemptKey: `${pi.id}_${pi.version}`,
        method: pi.payment_method_type!,
        currency: pi.charge_currency!,
        amount: pi.charge_amount!,
        details: paymentMethodDetails, // OTP/tokens: se usan y se descartan, nunca se persisten
      });
    } catch (err) {
      // Resultado desconocido (timeout, socket caído): queda en processing y el
      // reconciliador consulta al riel. Marcarlo como fallido podría duplicar un cobro.
      this.log.error(`Riel ${pi.rail} sin respuesta para ${pi.id}: ${(err as Error).message}`);
      return pi;
    }
    return this.applyRailResult(pi.id, result, `rail:${pi.rail}`);
  }

  /**
   * Aplica el resultado de un riel: respuesta síncrona, webhook del banco,
   * matcher de Pago Móvil P2P, listener de blockchain o conciliación Zelle.
   * Idempotente ante webhooks duplicados o tardíos.
   */
  applyRailResult(id: string, result: RailResult, actor: string): Promise<PaymentIntentRow> {
    return withTransaction(this.pool, async (c) => {
      let pi = await this.repo.lock(c, id);

      switch (result.status) {
        case 'succeeded': {
          if (pi.status === 'succeeded' || pi.status === 'settled') return pi;
          if (pi.status === 'requires_action') {
            pi = await this.repo.transition(c, pi, 'action_completed', { next_action: null }, { actor });
          }
          if (pi.status !== 'processing') return this.ignore(pi, result, actor);
          const entry = await this.ledger.post(c, paymentCaptureEntry({
            paymentIntentId: pi.id,
            merchantId: pi.merchant_id,
            rail: pi.rail!,
            chargeCurrency: pi.charge_currency!,
            chargeAmount: pi.charge_amount!,
            feeAmount: pi.fee_amount!,
            taxAmount: pi.tax_amount!,
            netAmount: pi.net_amount!,
            igtfAmount: pi.igtf_amount,
            fxRate: pi.fx_rate,
          }));
          return this.repo.transition(c, pi, 'rail_succeeded', {
            capture_entry_id: entry.entryId,
            rail_reference: result.reference,
            succeeded_at: new Date(),
            next_action: null,
          }, { actor, ledgerEntryId: entry.entryId, details: { rail_reference: result.reference } });
        }

        case 'requires_action':
          if (pi.status !== 'processing') return this.ignore(pi, result, actor);
          return this.repo.transition(c, pi, 'require_action', {
            next_action: result.nextAction,
            rail_reference: result.reference ?? pi.rail_reference,
          }, { actor });

        case 'pending':
          if (pi.status === 'processing' && pi.rail_reference !== result.reference) {
            await c.query('UPDATE payments.payment_intents SET rail_reference = $2 WHERE id = $1', [pi.id, result.reference]);
            return (await this.repo.find(c, pi.id))!;
          }
          return pi;

        case 'failed':
          if (pi.status !== 'processing' && pi.status !== 'requires_action') return this.ignore(pi, result, actor);
          return this.repo.transition(c, pi, 'rail_failed', {
            next_action: null,
            last_payment_error: { code: result.code, message: result.message, rail: pi.rail, rail_reference: result.reference ?? null },
          }, { actor, details: { code: result.code } });
      }
    });
  }

  cancel(merchantId: string, id: string, reason = 'requested_by_customer'): Promise<PaymentIntentRow> {
    return withTransaction(this.pool, async (c) => {
      const pi = await this.repo.lock(c, id, merchantId);
      return this.repo.transition(c, pi, 'cancel', { cancellation_reason: reason, canceled_at: new Date(), next_action: null },
        { actor: `merchant:${merchantId}` });
    });
  }

  /** Métodos que el pagador puede elegir en este pago, con los precios del comercio. */
  async availableMethods(pi: PaymentIntentRow): Promise<MethodSettings[]> {
    return allowedFor(await methodSettings(this.pool, pi.merchant_id), pi.payment_method_types);
  }

  private async assertMethodUsable(c: PoolClient, pi: PaymentIntentRow, type: PaymentMethodType): Promise<MethodSettings> {
    if (pi.payment_method_types && !pi.payment_method_types.includes(type)) {
      throw new ApiError(400, 'payment_method_not_allowed', `Este pago no acepta ${METHOD_NAMES[type]}`,
        'invalid_request_error', { param: 'payment_method_type', allowed: pi.payment_method_types });
    }
    const m = (await methodSettings(c, pi.merchant_id)).find((x) => x.type === type)!;
    if (m.state !== 'active') {
      throw new ApiError(403, 'payment_method_disabled', `${METHOD_NAMES[type]} no está disponible para este comercio (${STATE_TEXT[m.state]})`,
        'invalid_request_error', { param: 'payment_method_type', state: m.state });
    }
    return m;
  }

  /** Comisión fija definida en USD llevada a la moneda del cobro. */
  private async fixedFeeIn(c: PoolClient, usdMinor: bigint, to: Currency, piQuote: FrozenQuote | null, ttl: number) {
    if (usdMinor === 0n || to === 'USD') return { amount: usdMinor, quoteId: null };
    // USDT usa la tasa USD/USDT del exchange de la plataforma (fuente EXCHANGE), no paridad 1:1.
    if (piQuote && [piQuote.base, piQuote.quote].includes('USD') && [piQuote.base, piQuote.quote].includes(to)) {
      return { amount: convertWithQuote(usdMinor, 'USD', to, piQuote), quoteId: piQuote.id };
    }
    const q = await this.fx.freezeQuote(c, 'USD', to, defaultRateSource('USD', to), ttl);
    return { amount: convertWithQuote(usdMinor, 'USD', to, q), quoteId: q.id };
  }

  private async assertNotExpired(c: PoolClient, pi: PaymentIntentRow) {
    const { rows } = await c.query<{ expired: boolean }>('SELECT $1::timestamptz <= now() AS expired', [pi.expires_at]);
    if (rows[0].expired) throw new ApiError(409, 'payment_intent_expired', `El PaymentIntent ${pi.id} venció`, 'invalid_request_error');
  }

  private ignore(pi: PaymentIntentRow, result: RailResult, actor: string): PaymentIntentRow {
    // Webhook tardío o duplicado: no cambia nada. Un éxito tardío sobre un intent
    // cancelado o fallido requiere reverso/reembolso manual; se alerta.
    const level = result.status === 'succeeded' ? 'error' : 'warn';
    this.log[level](`Resultado "${result.status}" de ${actor} ignorado: ${pi.id} está en ${pi.status}`);
    return pi;
  }
}
