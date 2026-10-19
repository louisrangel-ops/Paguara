import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { INSTANCE_LIVEMODE } from '../common/api-key.guard';
import { ApiError, notFound } from '../common/errors';
import { Currency, isCurrency } from '../common/money';
import { PG_POOL } from '../database/database';
import { MerchantsService } from '../merchants/merchants.service';
import { PaymentIntentRow, toApi } from '../payment-intents/payment-intent.repository';
import { PaymentIntentsService } from '../payment-intents/payment-intents.service';
import { METHOD_NAMES, PaymentMethodType } from '../payment-intents/payment-methods';
import { STATE_TEXT, methodSettings } from '../capabilities/capability-state';

const CURRENCIES: Currency[] = ['VES', 'USD', 'USDT'];
const STATUS_GROUPS: Record<string, string[] | null> = {
  all: null,
  succeeded: ['succeeded', 'settled'],
  pending: ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'],
  canceled: ['canceled'],
};

export function summary(pi: PaymentIntentRow) {
  const a = toApi(pi);
  return {
    id: a.id, status: a.status, amount: a.amount, currency: a.currency,
    description: typeof pi.metadata?.description === 'string' ? pi.metadata.description : null,
    payment_method_type: a.payment_method_type, charge: a.charge, customer: a.customer, created: a.created,
    succeeded_at: pi.succeeded_at,
  };
}

/** Saldo que ve el comercio: las cuentas del comercio son pasivos (saldo acreedor, negativo en el ledger). */
const owed = (v: string | null | undefined) => (v ? (-BigInt(v)).toString() : '0');

@Injectable()
export class DashboardService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly merchants: MerchantsService,
    private readonly payments: PaymentIntentsService,
  ) {}

  async balances(merchantId: string) {
    const { rows } = await this.pool.query<{ code: string; balance: string }>(
      `SELECT a.code, b.balance::text FROM ledger.accounts a JOIN ledger.account_balances b ON b.account_id = a.id
        WHERE a.owner_type = 'merchant' AND a.owner_id = $1`, [merchantId]);
    const get = (bucket: string, c: string) => rows.find((r) => r.code === `merchant:${merchantId}:${bucket}:${c}`)?.balance;
    return CURRENCIES.map((c) => ({ currency: c, pending: owed(get('pending', c)), available: owed(get('available', c)) }));
  }

  async overview(merchantId: string) {
    const [balances, today, series, recent, action] = await Promise.all([
      this.balances(merchantId),
      this.pool.query<{ currency: string; amount: string; count: number }>(
        `SELECT charge_currency AS currency, sum(charge_amount)::text AS amount, count(*)::int AS count
           FROM payments.payment_intents
          WHERE merchant_id = $1 AND status IN ('succeeded', 'settled') AND succeeded_at >= date_trunc('day', now())
          GROUP BY charge_currency`, [merchantId]),
      this.pool.query<{ date: string; currency: string; amount: string; count: number }>(
        `SELECT to_char(date_trunc('day', succeeded_at), 'YYYY-MM-DD') AS date, charge_currency AS currency,
                sum(charge_amount)::text AS amount, count(*)::int AS count
           FROM payments.payment_intents
          WHERE merchant_id = $1 AND status IN ('succeeded', 'settled') AND succeeded_at >= date_trunc('day', now()) - interval '13 days'
          GROUP BY 1, 2 ORDER BY 1`, [merchantId]),
      this.pool.query<PaymentIntentRow>(
        `SELECT * FROM payments.payment_intents WHERE merchant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 6`, [merchantId]),
      this.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payments.payment_intents WHERE merchant_id = $1 AND status = 'requires_action'`, [merchantId]),
    ]);
    return {
      balances,
      today: { count: today.rows.reduce((s, r) => s + r.count, 0), volume: today.rows.map((r) => ({ currency: r.currency, amount: r.amount })) },
      series: series.rows,
      recent: recent.rows.map(summary),
      needs_action: action.rows[0].n,
    };
  }

  async listPayments(merchantId: string, q: { status?: string; q?: string; limit?: string; starting_after?: string }) {
    const group = STATUS_GROUPS[q.status ?? 'all'];
    if (group === undefined) throw new ApiError(400, 'status_invalid', 'Filtro de estado inválido');
    const n = Math.min(Math.max(Number(q.limit) || 25, 1), 100);
    const search = (q.q ?? '').trim().slice(0, 100);
    const { rows } = await this.pool.query<PaymentIntentRow>(
      `SELECT * FROM payments.payment_intents p
        WHERE p.merchant_id = $1
          AND ($2::text[] IS NULL OR p.status::text = ANY($2))
          AND ($3 = '' OR p.id = $3 OR p.metadata->>'description' ILIKE $6)
          AND ($4::text IS NULL OR (p.created_at, p.id) < (SELECT created_at, id FROM payments.payment_intents WHERE id = $4 AND merchant_id = $1))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $5`,
      [merchantId, group, search, q.starting_after || null, n + 1, `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`]);
    return { data: rows.slice(0, n).map(summary), has_more: rows.length > n };
  }

  async checkoutUrl(baseUrl: string, pi: { id: string; client_secret: string; merchant_id: string; livemode: boolean }) {
    const pk = await this.merchants.ensurePublishableKey(pi.merchant_id, pi.livemode);
    return `${baseUrl}/checkout?pi=${encodeURIComponent(pi.id)}&cs=${encodeURIComponent(pi.client_secret)}&pk=${encodeURIComponent(pk)}`;
  }

  async paymentDetail(merchantId: string, id: string, baseUrl: string) {
    const pi = await this.payments.retrieve(merchantId, id);
    const [timeline, payout] = await Promise.all([
      this.pool.query(
        `SELECT from_status AS "from", to_status AS "to", event, actor, created_at AS created
           FROM payments.payment_intent_transitions WHERE payment_intent_id = $1 ORDER BY id`, [id]),
      pi.settlement_entry_id
        ? this.pool.query(
          `SELECT p.id, b.batch_code, p.created_at AS created FROM settlements.payouts p JOIN settlements.batches b ON b.id = p.batch_id
            WHERE p.ledger_entry_id = $1`, [pi.settlement_entry_id])
        : Promise.resolve({ rows: [] }),
    ]);
    const a = toApi(pi);
    const open = ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status);
    return {
      ...summary(pi),
      fx: a.fx, next_action: a.next_action, last_payment_error: a.last_payment_error, metadata: a.metadata,
      expires_at: a.expires_at, cancellation_reason: a.cancellation_reason,
      checkout_url: open && pi.expires_at > new Date() ? await this.checkoutUrl(baseUrl, pi) : null,
      timeline: timeline.rows,
      payout: payout.rows[0] ?? null,
    };
  }

  async createPayment(merchantId: string, b: { amount?: unknown; currency?: string; description?: string; expires_in?: number }, baseUrl: string) {
    const amount = typeof b.amount === 'string' && /^\d{1,15}$/.test(b.amount) ? BigInt(b.amount)
      : typeof b.amount === 'number' && Number.isSafeInteger(b.amount) ? BigInt(b.amount) : null;
    if (amount === null || amount <= 0n) throw new ApiError(400, 'amount_invalid', 'Escribe un monto mayor que cero', 'invalid_request_error', { param: 'amount' });
    if (!b.currency || !isCurrency(b.currency) || !CURRENCIES.includes(b.currency)) throw new ApiError(400, 'currency_invalid', 'Moneda no soportada');
    const description = (b.description ?? '').trim().slice(0, 200);
    const pi = await this.payments.create(merchantId, {
      amount, currency: b.currency, metadata: description ? { description, source: 'dashboard' } : { source: 'dashboard' },
      expiresInSeconds: b.expires_in, livemode: INSTANCE_LIVEMODE,
    });
    return { payment: await this.paymentDetail(merchantId, pi.id, baseUrl), checkout_url: await this.checkoutUrl(baseUrl, pi) };
  }

  async payouts(merchantId: string) {
    const { rows } = await this.pool.query(
      `SELECT p.id, b.batch_code, p.source_currency, p.source_amount::text AS source_amount, p.created_at AS created,
              coalesce(json_agg(json_build_object('currency', i.currency, 'amount', i.amount::text, 'fx_rate', i.fx_rate::text,
                'fx_spread_bps', i.fx_spread_bps, 'destination', i.destination, 'status', i.status) ORDER BY i.id)
                FILTER (WHERE i.id IS NOT NULL), '[]') AS instructions
         FROM settlements.payouts p JOIN settlements.batches b ON b.id = p.batch_id
         LEFT JOIN settlements.payout_instructions i ON i.payout_id = p.id
        WHERE p.merchant_id = $1 GROUP BY p.id, b.batch_code ORDER BY p.created_at DESC LIMIT 50`, [merchantId]);
    return rows.map((r) => ({ ...r, instructions: r.instructions.map((i: { fx_rate: string | null }) => ({
      ...i, fx_rate: i.fx_rate ? i.fx_rate.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : null })) }));
  }

  async settlementRules(merchantId: string) {
    const { rows } = await this.pool.query<{ source_currency: Currency; target_currency: string; bps: number; destination: unknown }>(
      `SELECT source_currency, target_currency, bps, destination FROM merchants.settlement_rules
        WHERE merchant_id = $1 ORDER BY source_currency, bps DESC`, [merchantId]);
    const rules: Record<string, unknown[]> = { VES: [], USD: [], USDT: [] };
    for (const r of rows) rules[r.source_currency]?.push({ target_currency: r.target_currency, bps: r.bps, destination: r.destination });
    return { rules };
  }

  async saveSettlementRules(merchantId: string, source: string, rules: Array<{ target_currency?: string; bps?: number; destination?: Record<string, unknown> }>) {
    if (!isCurrency(source) || !CURRENCIES.includes(source)) throw new ApiError(400, 'currency_invalid', 'Moneda origen no soportada');
    if (!Array.isArray(rules) || rules.length === 0 || rules.length > 3) throw new ApiError(400, 'settlement_rules_invalid', 'Define entre 1 y 3 destinos');
    const seen = new Set<string>();
    const clean = rules.map((r) => {
      const t = r.target_currency ?? '';
      if (!isCurrency(t) || !CURRENCIES.includes(t) || seen.has(t)) throw new ApiError(400, 'settlement_rules_invalid', 'Cada destino debe tener una moneda distinta');
      seen.add(t);
      if (!Number.isInteger(r.bps) || r.bps! <= 0) throw new ApiError(400, 'settlement_rules_invalid', 'Cada porcentaje debe ser mayor que cero');
      if (!r.destination || typeof r.destination !== 'object' || JSON.stringify(r.destination).length > 1000) {
        throw new ApiError(400, 'settlement_rules_invalid', 'Falta el destino del pago');
      }
      return { targetCurrency: t, bps: r.bps!, destination: r.destination };
    });
    await this.merchants.setSettlementRules(merchantId, source, clean);
    return this.settlementRules(merchantId);
  }

  // ---- Links de pago ------------------------------------------------------

  async listLinks(merchantId: string, baseUrl: string) {
    const { rows } = await this.pool.query(
      `SELECT l.id, l.slug, l.amount::text AS amount, l.currency, l.description, l.active, l.payment_method_types, l.created_at AS created,
              count(p.id)::int AS payments_count, count(p.id) FILTER (WHERE p.status IN ('succeeded', 'settled'))::int AS succeeded_count
         FROM payments.payment_links l LEFT JOIN payments.payment_intents p ON p.payment_link_id = l.id
        WHERE l.merchant_id = $1 GROUP BY l.id ORDER BY l.created_at DESC`, [merchantId]);
    return rows.map(({ slug, ...r }) => ({ ...r, url: `${baseUrl}/pay/${slug}` }));
  }

  async createLink(merchantId: string, b: { amount?: unknown; currency?: string; description?: string; payment_method_types?: PaymentMethodType[] | null }, baseUrl: string) {
    const amount = typeof b.amount === 'string' && /^\d{1,15}$/.test(b.amount) ? BigInt(b.amount)
      : typeof b.amount === 'number' && Number.isSafeInteger(b.amount) ? BigInt(b.amount) : null;
    if (amount === null || amount <= 0n) throw new ApiError(400, 'amount_invalid', 'Escribe un monto mayor que cero', 'invalid_request_error', { param: 'amount' });
    if (!b.currency || !isCurrency(b.currency) || !CURRENCIES.includes(b.currency)) throw new ApiError(400, 'currency_invalid', 'Moneda no soportada');
    const description = (b.description ?? '').trim();
    if (description.length < 1 || description.length > 200) {
      throw new ApiError(400, 'description_invalid', 'Escribe qué estás cobrando (hasta 200 caracteres)', 'invalid_request_error', { param: 'description' });
    }
    const only = b.payment_method_types ?? null;
    if (only) {
      const off = (await methodSettings(this.pool, merchantId)).find((m) => only.includes(m.type) && m.state !== 'active');
      if (off) {
        throw new ApiError(400, 'payment_method_not_allowed', `${METHOD_NAMES[off.type]} no está activo en tu cuenta (${STATE_TEXT[off.state]})`,
          'invalid_request_error', { param: 'payment_method_types' });
      }
    }
    const id = `plink_${randomBytes(8).toString('hex')}`;
    await this.pool.query(
      `INSERT INTO payments.payment_links (id, merchant_id, slug, amount, currency, description, livemode, payment_method_types)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, merchantId, randomBytes(12).toString('base64url').replace(/[-_]/g, 'x'), amount.toString(), b.currency, description, INSTANCE_LIVEMODE, only]);
    return (await this.listLinks(merchantId, baseUrl)).find((l) => l.id === id);
  }

  async setLinkActive(merchantId: string, id: string, active: boolean, baseUrl: string) {
    const res = await this.pool.query('UPDATE payments.payment_links SET active = $3 WHERE id = $1 AND merchant_id = $2', [id, merchantId, active]);
    if (res.rowCount === 0) throw notFound('el link', id);
    return (await this.listLinks(merchantId, baseUrl)).find((l) => l.id === id);
  }

  async findActiveLink(slug: string) {
    const { rows } = await this.pool.query<{ id: string; merchant_id: string; amount: string; currency: Currency; description: string; livemode: boolean;
                                             payment_method_types: PaymentMethodType[] | null }>(
      `SELECT id, merchant_id, amount::text, currency, description, livemode, payment_method_types FROM payments.payment_links WHERE slug = $1 AND active`, [slug]);
    return rows[0] ?? null;
  }
}
