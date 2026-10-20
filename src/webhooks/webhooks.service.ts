import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { openSecret, sealSecret } from '../common/secret-box';
import { createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup, LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Pool, PoolClient } from 'pg';
import { ApiError, notFound } from '../common/errors';
import { PG_POOL } from '../database/database';
import { assertModuleActive } from '../capabilities/capability-state';

export const EVENT_TYPES = [
  'payment_intent.created',
  'payment_intent.requires_action',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.settled',
  'payout.created',
  'account.capability.updated',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 10_000;
const LEASE_SECONDS = 60;

/**
 * Outbox: se llama dentro de la transacción que produjo el cambio. El evento y
 * sus entregas (una por endpoint suscrito) se confirman o se descartan junto
 * con el pago. Con el módulo de webhooks apagado el evento igual queda
 * registrado (se ve en el panel), pero no se programa ninguna entrega.
 */
export async function enqueueEvent(
  client: PoolClient,
  e: { merchantId: string; livemode: boolean; type: EventType; objectId: string; object: Record<string, unknown> },
): Promise<string> {
  const id = `evt_${randomBytes(12).toString('hex')}`;
  const payload = {
    id, object: 'event', type: e.type, livemode: e.livemode, created: Math.floor(Date.now() / 1000), data: { object: e.object },
  };
  await client.query(
    `INSERT INTO webhooks.events (id, merchant_id, type, object_id, livemode, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, e.merchantId, e.type, e.objectId, e.livemode, JSON.stringify(payload)],
  );
  await client.query(
    `INSERT INTO webhooks.deliveries (event_id, endpoint_id)
     SELECT $1, id FROM webhooks.endpoints
      WHERE merchant_id = $2 AND status = 'enabled' AND ($3 = ANY(enabled_events) OR '*' = ANY(enabled_events))
        AND merchants.capability_state($2, 'webhooks') = 'active'`,
    [id, e.merchantId, e.type],
  );
  return id;
}

/** `Webhook-Signature: t=<unix>,v1=<hex>` con v1 = HMAC-SHA256(secret, "<t>.<cuerpo>"). */
export function signPayload(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Espera antes del intento n+1: 30 s, 1, 2, 4, 8, 16, 32 min. */
export function backoffSeconds(attempts: number): number {
  return 30 * 2 ** (attempts - 1);
}

/** Direcciones a las que nunca se envía un webhook (red interna, metadata de la nube). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

const allowHttp = () => process.env.WEBHOOK_ALLOW_HTTP === 'true';
const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === 'true';

export function validateEndpointUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ApiError(400, 'url_invalid', 'La URL del webhook no es válida'); }
  if (u.protocol !== 'https:' && !(allowHttp() && u.protocol === 'http:')) {
    throw new ApiError(400, 'url_invalid', 'La URL del webhook debe usar https://');
  }
  if (u.username || u.password) throw new ApiError(400, 'url_invalid', 'La URL no puede llevar usuario ni clave');
  if (!allowPrivate() && (u.hostname === 'localhost' || (isIP(u.hostname) && isPrivateAddress(u.hostname)))) {
    throw new ApiError(400, 'url_invalid', 'La URL del webhook debe ser pública');
  }
  return u.toString();
}

/**
 * Resolución DNS que valida la IP efectivamente usada para conectar (no solo la
 * del momento de registrar la URL): evita que un dominio apunte luego a la red interna.
 */
function guardedLookup(hostname: string, options: object, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = addresses as LookupAddress[];
    const bad = !allowPrivate() && list.find((a) => isPrivateAddress(a.address));
    if (bad) return cb(new Error(`destino privado bloqueado (${bad.address})`), '');
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

export interface DeliveryResult { ok: boolean; statusCode: number | null; error: string | null }

function post(url: string, body: string, headers: Record<string, string>): Promise<DeliveryResult> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST', timeout: TIMEOUT_MS, lookup: guardedLookup as never,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
    }, (res) => {
      res.resume(); // la respuesta del comercio no se lee ni se guarda
      const code = res.statusCode ?? 0;
      resolve({ ok: code >= 200 && code < 300, statusCode: code, error: code >= 200 && code < 300 ? null : `HTTP ${code}` });
    });
    req.on('timeout', () => req.destroy(new Error('tiempo de espera agotado')));
    req.on('error', (e) => resolve({ ok: false, statusCode: null, error: e.message.slice(0, 300) }));
    req.end(body);
  });
}

@Injectable()
export class WebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WebhooksService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  onModuleInit() {
    if (process.env.WEBHOOK_WORKER === 'false') return;
    this.timer = setInterval(() => { void this.tick(); }, Number(process.env.WEBHOOK_POLL_MS ?? 2000));
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try { await this.deliverDue(); } catch (e) { this.log.error(`Entrega de webhooks: ${(e as Error).message}`); } finally { this.running = false; }
  }

  /**
   * Toma entregas vencidas con lease (SKIP LOCKED: varios workers no repiten la misma) y las envía.
   * Si el comercio apagó el módulo de webhooks, sus entregas pendientes esperan a que lo encienda.
   */
  async deliverDue(limit = 20): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; attempts: number; url: string; secret: string; payload: unknown; event_id: string }>(
      `UPDATE webhooks.deliveries d SET next_attempt_at = now() + make_interval(secs => $2)
         FROM webhooks.endpoints e, webhooks.events ev
        WHERE d.id IN (SELECT pd.id FROM webhooks.deliveries pd JOIN webhooks.endpoints pe ON pe.id = pd.endpoint_id
                        WHERE pd.status = 'pending' AND pd.next_attempt_at <= now()
                          AND merchants.capability_state(pe.merchant_id, 'webhooks') = 'active'
                        ORDER BY pd.next_attempt_at LIMIT $1 FOR UPDATE OF pd SKIP LOCKED)
          AND e.id = d.endpoint_id AND ev.id = d.event_id
       RETURNING d.id, d.attempts, e.url, e.secret, ev.payload, ev.id AS event_id`,
      [limit, LEASE_SECONDS],
    );
    await Promise.all(rows.map(async (r) => {
      const body = JSON.stringify(r.payload);
      const result = await post(r.url, body, {
        'Content-Type': 'application/json', 'User-Agent': 'PasarelaWebhooks/1.0', 'Webhook-Id': r.event_id,
        'Webhook-Signature': signPayload(openSecret(r.secret), body, Math.floor(Date.now() / 1000)),
      });
      const attempts = r.attempts + 1;
      const status = result.ok ? 'succeeded' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      await this.pool.query(
        `UPDATE webhooks.deliveries SET status = $2, attempts = $3, last_status_code = $4, last_error = $5,
                delivered_at = CASE WHEN $2 = 'succeeded' THEN now() END,
                next_attempt_at = now() + make_interval(secs => $6)
          WHERE id = $1`,
        [r.id, status, attempts, result.statusCode, result.error, backoffSeconds(attempts)],
      );
    }));
    return rows.length;
  }

  // ---- Endpoints --------------------------------------------------------

  async createEndpoint(merchantId: string, url: string, events: string[]) {
    const clean = [...new Set(events)];
    if (clean.length === 0 || clean.some((t) => t !== '*' && !(EVENT_TYPES as readonly string[]).includes(t))) {
      throw new ApiError(400, 'events_invalid', 'Elige al menos un tipo de evento válido');
    }
    await assertModuleActive(this.pool, merchantId, 'webhooks');
    const id = `we_${randomBytes(10).toString('hex')}`;
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    await this.pool.query(
      `INSERT INTO webhooks.endpoints (id, merchant_id, url, secret, enabled_events) VALUES ($1, $2, $3, $4, $5)`,
      [id, merchantId, validateEndpointUrl(url), sealSecret(secret), clean]);
    return { ...(await this.getEndpoint(merchantId, id)), secret };
  }

  async listEndpoints(merchantId: string) {
    const { rows } = await this.pool.query(
      `SELECT e.id, e.url, e.enabled_events, e.status, e.created_at AS created,
              (SELECT json_build_object('status', d.status, 'at', coalesce(d.delivered_at, d.next_attempt_at), 'status_code', d.last_status_code)
                 FROM webhooks.deliveries d WHERE d.endpoint_id = e.id AND d.attempts > 0
                ORDER BY d.id DESC LIMIT 1) AS last_delivery
         FROM webhooks.endpoints e WHERE e.merchant_id = $1 ORDER BY e.created_at DESC`, [merchantId]);
    return rows;
  }

  async getEndpoint(merchantId: string, id: string) {
    const ep = (await this.listEndpoints(merchantId)).find((e) => e.id === id);
    if (!ep) throw notFound('el webhook', id);
    return ep;
  }

  async revealSecret(merchantId: string, id: string) {
    const { rows } = await this.pool.query<{ secret: string }>(
      'SELECT secret FROM webhooks.endpoints WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
    if (!rows[0]) throw notFound('el webhook', id);
    return { secret: openSecret(rows[0].secret) };
  }

  async setStatus(merchantId: string, id: string, status: 'enabled' | 'disabled') {
    if (status === 'enabled') await assertModuleActive(this.pool, merchantId, 'webhooks');
    const res = await this.pool.query('UPDATE webhooks.endpoints SET status = $3 WHERE id = $1 AND merchant_id = $2', [id, merchantId, status]);
    if (res.rowCount === 0) throw notFound('el webhook', id);
    return this.getEndpoint(merchantId, id);
  }

  /** Evento de prueba solo hacia ese endpoint (no se reparte a los demás). */
  async sendTest(merchantId: string, id: string, livemode: boolean) {
    await this.getEndpoint(merchantId, id);
    await assertModuleActive(this.pool, merchantId, 'webhooks');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventId = `evt_${randomBytes(12).toString('hex')}`;
      const payload = { id: eventId, object: 'event', type: 'payment_intent.succeeded', livemode, created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'pi_prueba', object: 'payment_intent', status: 'succeeded', amount: '2500', currency: 'USD', test_event: true } } };
      await client.query(
        `INSERT INTO webhooks.events (id, merchant_id, type, object_id, livemode, payload) VALUES ($1, $2, 'payment_intent.succeeded', 'pi_prueba', $3, $4)`,
        [eventId, merchantId, livemode, JSON.stringify(payload)]);
      await client.query('INSERT INTO webhooks.deliveries (event_id, endpoint_id) VALUES ($1, $2)', [eventId, id]);
      await client.query('COMMIT');
      return { event_id: eventId };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ---- Eventos ----------------------------------------------------------

  async listEvents(merchantId: string, limit: number, startingAfter?: string, onlyId?: string) {
    const n = Math.min(Math.max(limit || 25, 1), 100);
    const { rows } = await this.pool.query(
      `SELECT ev.id, ev.type, ev.created_at AS created, ev.object_id,
              coalesce((SELECT json_agg(json_build_object('endpoint_id', d.endpoint_id, 'url', e.url, 'status', d.status,
                         'attempts', d.attempts, 'last_status_code', d.last_status_code,
                         'next_attempt_at', CASE WHEN d.status = 'pending' THEN d.next_attempt_at END) ORDER BY d.id)
                          FROM webhooks.deliveries d JOIN webhooks.endpoints e ON e.id = d.endpoint_id
                         WHERE d.event_id = ev.id), '[]') AS deliveries
         FROM webhooks.events ev
        WHERE ev.merchant_id = $1
          AND ($2::text IS NULL OR (ev.created_at, ev.id) < (SELECT created_at, id FROM webhooks.events WHERE id = $2 AND merchant_id = $1))
          AND ($4::text IS NULL OR ev.id = $4)
        ORDER BY ev.created_at DESC, ev.id DESC LIMIT $3`,
      [merchantId, startingAfter ?? null, n + 1, onlyId ?? null]);
    return { data: rows.slice(0, n), has_more: rows.length > n };
  }

  async getEvent(merchantId: string, id: string) {
    const { rows } = await this.pool.query('SELECT payload FROM webhooks.events WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
    if (!rows[0]) throw notFound('el evento', id);
    const { data } = await this.listEvents(merchantId, 1, undefined, id);
    return { ...data[0], payload: rows[0].payload };
  }

  /** Reenvía a todos los endpoints de ese evento (también a los que ya respondieron 2xx). */
  async resend(merchantId: string, id: string) {
    await assertModuleActive(this.pool, merchantId, 'webhooks');
    const res = await this.pool.query(
      `UPDATE webhooks.deliveries d SET status = 'pending', next_attempt_at = now(), attempts = 0
         FROM webhooks.events ev WHERE ev.id = d.event_id AND ev.id = $1 AND ev.merchant_id = $2`, [id, merchantId]);
    if (res.rowCount === 0) throw notFound('el evento', id);
    return { ok: true };
  }
}
