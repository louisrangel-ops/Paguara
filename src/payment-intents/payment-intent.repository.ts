import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { Currency } from '../common/money';
import { notFound } from '../common/errors';
import { PaymentMethodType } from './payment-methods';
import { PaymentIntentEventType, PaymentIntentStatus, nextStatus } from './payment-intent.state-machine';
import { enqueueEvent, EventType } from '../webhooks/webhooks.service';

/** Qué cambios se avisan por webhook al comercio. */
function webhookType(event: PaymentIntentEventType, to: PaymentIntentStatus): EventType | null {
  if (event === 'rail_failed') return 'payment_intent.payment_failed';
  if (to === 'requires_action') return 'payment_intent.requires_action';
  if (to === 'succeeded') return 'payment_intent.succeeded';
  if (to === 'canceled') return 'payment_intent.canceled';
  if (to === 'settled') return 'payment_intent.settled';
  return null;
}

/** Lo que recibe el comercio en el webhook: la vista de la API sin el client_secret. */
export function webhookObject(pi: PaymentIntentRow): Record<string, unknown> {
  const { client_secret: _omit, ...rest } = toApi(pi);
  return rest;
}

export interface PaymentIntentRow {
  id: string;
  merchant_id: string;
  amount: bigint;
  currency: Currency;
  payment_method_type: PaymentMethodType | null;
  rail: string | null;
  charge_currency: Currency | null;
  charge_amount: bigint | null;
  fx_quote_id: string | null;
  fx_rate: string | null;
  fx_rate_source: string | null;
  fx_quote_expires_at: Date | null;
  fee_amount: bigint | null;
  tax_amount: bigint | null;
  net_amount: bigint | null;
  igtf_amount: bigint;
  status: PaymentIntentStatus;
  version: number;
  next_action: Record<string, unknown> | null;
  last_payment_error: Record<string, unknown> | null;
  rail_reference: string | null;
  capture_entry_id: string | null;
  funds_received_entry_id: string | null;
  settlement_entry_id: string | null;
  cancellation_reason: string | null;
  metadata: Record<string, unknown>;
  livemode: boolean;
  idempotency_key: string | null;
  client_secret: string;
  customer: Record<string, unknown> | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  processing_at: Date | null;
  succeeded_at: Date | null;
  settled_at: Date | null;
  canceled_at: Date | null;
  payment_link_id: string | null;
  payment_method_types: PaymentMethodType[] | null;
}

/** Columnas que una transición puede modificar. id, comercio, monto y moneda nunca cambian. */
const PATCHABLE = new Set([
  'payment_method_type', 'rail', 'charge_currency', 'charge_amount', 'fx_quote_id', 'fx_rate',
  'fx_rate_source', 'fx_quote_expires_at', 'fee_amount', 'tax_amount', 'net_amount', 'igtf_amount', 'next_action',
  'last_payment_error', 'rail_reference', 'capture_entry_id', 'funds_received_entry_id',
  'settlement_entry_id', 'cancellation_reason', 'processing_at', 'succeeded_at', 'settled_at', 'canceled_at',
]);
const JSON_COLUMNS = new Set(['next_action', 'last_payment_error']);

export type PaymentIntentPatch = Partial<Record<string, unknown>>;

const SELECT = `SELECT * FROM payments.payment_intents`; // numeric llega como string desde pg

function normalize(row: PaymentIntentRow): PaymentIntentRow {
  if (row.fx_rate) row.fx_rate = row.fx_rate.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return row;
}

@Injectable()
export class PaymentIntentRepository {
  async find(client: PoolClient, id: string): Promise<PaymentIntentRow | null> {
    const res = await client.query<PaymentIntentRow>(`${SELECT} WHERE id = $1`, [id]);
    return res.rows[0] ? normalize(res.rows[0]) : null;
  }

  /** Lock pesimista de la fila: serializa confirmaciones, webhooks y liquidaciones del mismo intent. */
  async lock(client: PoolClient, id: string, merchantId?: string): Promise<PaymentIntentRow> {
    const res = await client.query<PaymentIntentRow>(`${SELECT} WHERE id = $1 FOR UPDATE`, [id]);
    const row = res.rows[0];
    if (!row || (merchantId !== undefined && row.merchant_id !== merchantId)) throw notFound('el PaymentIntent', id);
    return normalize(row);
  }

  async lockMany(client: PoolClient, ids: string[]): Promise<PaymentIntentRow[]> {
    const res = await client.query<PaymentIntentRow>(`${SELECT} WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids]);
    const found = new Set(res.rows.map((r) => r.id));
    const missing = ids.find((id) => !found.has(id));
    if (missing) throw notFound('el PaymentIntent', missing);
    return res.rows.map(normalize);
  }

  /**
   * Inserta; si (comercio, idempotency_key) ya existe devuelve el existente con
   * `created: false`. Respaldo durable de la idempotencia de Redis.
   */
  async insert(
    client: PoolClient,
    row: { id: string; merchantId: string; amount: bigint; currency: Currency; metadata: Record<string, unknown>;
           livemode: boolean; idempotencyKey: string | null; clientSecret: string; customer: Record<string, unknown> | null;
           ttlSeconds: number; paymentLinkId?: string | null; paymentMethodTypes?: string[] | null },
    actor: string,
  ): Promise<{ pi: PaymentIntentRow; created: boolean }> {
    const res = await client.query<PaymentIntentRow>(
      `INSERT INTO payments.payment_intents
         (id, merchant_id, amount, currency, metadata, livemode, idempotency_key, client_secret, customer, expires_at, payment_link_id,
          payment_method_types)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10), $11, $12)
       ON CONFLICT (merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [row.id, row.merchantId, row.amount.toString(), row.currency, JSON.stringify(row.metadata), row.livemode,
       row.idempotencyKey, row.clientSecret, row.customer ? JSON.stringify(row.customer) : null, row.ttlSeconds,
       row.paymentLinkId ?? null, row.paymentMethodTypes ?? null],
    );
    if (res.rowCount === 0) {
      const existing = await client.query<PaymentIntentRow>(
        `${SELECT} WHERE merchant_id = $1 AND idempotency_key = $2`, [row.merchantId, row.idempotencyKey]);
      return { pi: normalize(existing.rows[0]), created: false };
    }
    await client.query(
      `INSERT INTO payments.payment_intent_transitions (payment_intent_id, from_status, to_status, event, actor)
       VALUES ($1, NULL, 'requires_payment_method', 'create', $2)`, [row.id, actor]);
    const pi = normalize(res.rows[0]);
    await enqueueEvent(client, { merchantId: pi.merchant_id, livemode: pi.livemode, type: 'payment_intent.created', objectId: pi.id, object: webhookObject(pi) });
    return { pi, created: true };
  }

  /**
   * Aplica un evento: valida con la máquina de estados, actualiza la fila y deja
   * rastro en payment_intent_transitions, todo en la transacción del llamador.
   */
  async transition(
    client: PoolClient,
    pi: PaymentIntentRow,
    event: PaymentIntentEventType,
    patch: PaymentIntentPatch,
    audit: { actor: string; details?: Record<string, unknown>; ledgerEntryId?: string },
  ): Promise<PaymentIntentRow> {
    const to = nextStatus(pi.status, event);
    const sets = ['status = $2'];
    const values: unknown[] = [pi.id, to];
    for (const [col, value] of Object.entries(patch)) {
      if (!PATCHABLE.has(col)) throw new Error(`Columna no modificable: ${col}`);
      values.push(
        value === null || value === undefined ? null
          : typeof value === 'bigint' ? value.toString()
          : JSON_COLUMNS.has(col) ? JSON.stringify(value)
          : value,
      );
      sets.push(`${col} = $${values.length}`);
    }
    values.push(pi.version);
    const res = await client.query<PaymentIntentRow>(
      `UPDATE payments.payment_intents SET ${sets.join(', ')}
        WHERE id = $1 AND version = $${values.length}
        RETURNING *`,
      values,
    );
    if (res.rowCount === 0) throw new Error(`Conflicto de versión en ${pi.id}`); // no ocurre si se tomó lock()
    await client.query(
      `INSERT INTO payments.payment_intent_transitions
         (payment_intent_id, from_status, to_status, event, actor, details, ledger_entry_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [pi.id, pi.status, to, event, audit.actor, JSON.stringify(audit.details ?? {}), audit.ledgerEntryId ?? null],
    );
    const updated = normalize(res.rows[0]);
    const type = webhookType(event, to);
    if (type) await enqueueEvent(client, { merchantId: updated.merchant_id, livemode: updated.livemode, type, objectId: updated.id, object: webhookObject(updated) });
    return updated;
  }
}

/** Representación para el servidor del comercio (llave secreta). Montos como string de enteros. */
export function toApi(pi: PaymentIntentRow) {
  const s = (v: bigint | null) => (v === null ? null : v.toString());
  return {
    id: pi.id,
    object: 'payment_intent',
    status: pi.status,
    amount: s(pi.amount),
    currency: pi.currency,
    payment_method_type: pi.payment_method_type,
    payment_method_types: pi.payment_method_types,
    charge: pi.charge_currency && {
      amount: s(pi.charge_amount),
      currency: pi.charge_currency,
      fee: s(pi.fee_amount),
      tax: s(pi.tax_amount),
      net: s(pi.net_amount),
      igtf: s(pi.igtf_amount),
    },
    fx: pi.fx_quote_id && {
      quote_id: pi.fx_quote_id,
      rate: pi.fx_rate,
      source: pi.fx_rate_source,
      expires_at: pi.fx_quote_expires_at,
      frozen: ['processing', 'requires_action', 'succeeded', 'settled'].includes(pi.status),
    },
    next_action: pi.next_action,
    last_payment_error: pi.last_payment_error,
    cancellation_reason: pi.cancellation_reason,
    metadata: pi.metadata,
    customer: pi.customer,
    client_secret: pi.client_secret,
    livemode: pi.livemode,
    expires_at: pi.expires_at,
    created: pi.created_at,
    version: pi.version,
  };
}

/** Vista del checkout (navegador del pagador): sin metadata ni datos internos del comercio. */
export function toCheckoutApi(pi: PaymentIntentRow) {
  const full = toApi(pi);
  return {
    id: full.id,
    object: 'payment_intent',
    status: full.status,
    amount: full.amount,
    currency: full.currency,
    description: typeof pi.metadata.description === 'string' ? pi.metadata.description : null,
    payment_method_type: full.payment_method_type,
    charge: full.charge && { amount: full.charge.amount, currency: full.charge.currency, igtf: full.charge.igtf },
    fx: full.fx && { rate: full.fx.rate, source: full.fx.source, expires_at: full.fx.expires_at, frozen: full.fx.frozen },
    next_action: full.next_action,
    last_payment_error: full.last_payment_error && { code: full.last_payment_error.code, message: full.last_payment_error.message },
    expires_at: full.expires_at,
  };
}
