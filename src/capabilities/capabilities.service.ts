import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { INSTANCE_LIVEMODE } from '../common/api-key.guard';
import { ApiError } from '../common/errors';
import { PG_POOL, withTransaction } from '../database/database';
import { METHOD_NAMES, PAYMENT_METHODS, PaymentMethodType, isPaymentMethodType } from '../payment-intents/payment-methods';
import { enqueueEvent } from '../webhooks/webhooks.service';
import { CapabilityRow, Db, MODULE_NAMES, ModuleKey, ROWS, STATE_TEXT, toSettings } from './capability-state';

/** Vista pública de una capacidad (panel, API del comercio, webhook). */
function view(r: CapabilityRow) {
  const isMethod = r.kind === 'method' && isPaymentMethodType(r.key);
  const s = isMethod ? toSettings(r) : null;
  return {
    object: 'capability',
    key: r.key,
    kind: r.kind,
    name: isMethod ? METHOD_NAMES[r.key as PaymentMethodType] : MODULE_NAMES[r.key as ModuleKey] ?? r.key,
    state: r.state,
    /** El comercio solo puede mover el interruptor si la plataforma se lo permite. */
    can_toggle: r.state === 'active' || r.state === 'disabled',
    can_request: r.state === 'not_granted',
    ...(s && {
      currency: s.cfg.chargeCurrency,
      fee_bps: s.cfg.feeBps,
      fixed_usd: s.cfg.feeFixedUsd.toString(),
      tax_bps: s.cfg.feeTaxBps,
      igtf_bps: s.cfg.igtfBps,
      custom_pricing: r.fee_bps !== null || r.fee_fixed_usd !== null,
      min_amount: s.minAmount?.toString() ?? null,
      max_amount: s.maxAmount?.toString() ?? null,
    }),
  };
}
export type CapabilityView = ReturnType<typeof view>;

export interface PlatformMerchantPatch {
  platform_status?: 'allowed' | 'pending_review' | 'blocked';
  fee_bps?: number | null;
  fee_fixed_usd?: string | number | null;
  min_amount?: string | number | null;
  max_amount?: string | number | null;
}

@Injectable()
export class CapabilitiesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(merchantId: string): Promise<CapabilityView[]> {
    const { rows } = await this.pool.query<CapabilityRow>(ROWS, [merchantId]);
    // Métodos en el orden del catálogo (el mismo del checkout), luego los módulos
    const order = [...Object.keys(PAYMENT_METHODS), ...Object.keys(MODULE_NAMES)];
    const pos = (k: string) => (order.indexOf(k) + 1 || order.length + 1);
    return rows.sort((a, b) => pos(a.key) - pos(b.key) || a.key.localeCompare(b.key)).map(view);
  }

  async get(db: Db, merchantId: string, key: string): Promise<CapabilityView> {
    const { rows } = await db.query<CapabilityRow>(`${ROWS} WHERE pc.key = $2`, [merchantId, key]);
    if (!rows[0]) throw new ApiError(404, 'resource_missing', `No existe la capacidad ${key}`);
    return view(rows[0]);
  }

  /** El comercio enciende o apaga algo que la plataforma ya le permitió. */
  async setMerchantEnabled(merchantId: string, key: string, enabled: unknown, actor: string): Promise<CapabilityView> {
    if (typeof enabled !== 'boolean') throw new ApiError(400, 'enabled_invalid', 'enabled debe ser true o false', 'invalid_request_error', { param: 'enabled' });
    return withTransaction(this.pool, async (c) => {
      const before = await this.lockRow(c, merchantId, key);
      if (before.state !== 'active' && before.state !== 'disabled') {
        throw new ApiError(409, 'capability_locked', `No puedes cambiar ${before.name}: está ${STATE_TEXT[before.state]}`,
          'invalid_request_error', { capability: key, state: before.state });
      }
      if (enabled === (before.state === 'active')) return before;
      await c.query(`UPDATE merchants.capabilities SET merchant_enabled = $3, updated_by = $4, updated_at = now()
                      WHERE merchant_id = $1 AND key = $2`, [merchantId, key, enabled, actor]);
      return this.recordChange(c, merchantId, key, actor, before);
    });
  }

  /** "Solicitar": queda en revisión hasta que la plataforma lo apruebe. */
  async request(merchantId: string, key: string, actor: string): Promise<CapabilityView> {
    return withTransaction(this.pool, async (c) => {
      const before = await this.lockRow(c, merchantId, key);
      if (before.state === 'pending_review') return before;
      if (before.state !== 'not_granted') {
        throw new ApiError(409, 'capability_not_requestable', `${before.name} está ${STATE_TEXT[before.state]}`, 'invalid_request_error', { capability: key, state: before.state });
      }
      await c.query(`INSERT INTO merchants.capabilities (merchant_id, key, platform_status, updated_by) VALUES ($1, $2, 'pending_review', $3)`,
        [merchantId, key, actor]);
      return this.recordChange(c, merchantId, key, actor, before);
    });
  }

  /** Plataforma: aprobar, bloquear o negociar precio y límites con un comercio. */
  async platformSetForMerchant(merchantId: string, key: string, patch: PlatformMerchantPatch, actor: string): Promise<CapabilityView> {
    const status = patch.platform_status;
    if (status !== undefined && !['allowed', 'pending_review', 'blocked'].includes(status)) {
      throw new ApiError(400, 'platform_status_invalid', 'platform_status debe ser allowed, pending_review o blocked');
    }
    const num = (v: unknown, param: string): string | null | undefined => {
      if (v === undefined || v === null) return v as null | undefined;
      if ((typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^\d{1,15}$/.test(v))) return String(v);
      throw new ApiError(400, 'capability_invalid', `${param} debe ser un entero o null`, 'invalid_request_error', { param });
    };
    const values = {
      platform_status: status,
      fee_bps: num(patch.fee_bps, 'fee_bps'),
      fee_fixed_usd: num(patch.fee_fixed_usd, 'fee_fixed_usd'),
      min_amount: num(patch.min_amount, 'min_amount'),
      max_amount: num(patch.max_amount, 'max_amount'),
    };
    return withTransaction(this.pool, async (c) => {
      const before = await this.lockRow(c, merchantId, key);
      if (before.kind !== 'method' && (values.fee_bps !== undefined || values.fee_fixed_usd !== undefined
        || values.min_amount !== undefined || values.max_amount !== undefined)) {
        throw new ApiError(400, 'capability_invalid', 'Los módulos no tienen precio ni límites');
      }
      await c.query(`INSERT INTO merchants.capabilities (merchant_id, key, updated_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [merchantId, key, actor]);
      const sets: string[] = [];
      const args: unknown[] = [merchantId, key, actor];
      for (const [col, v] of Object.entries(values)) {
        if (v === undefined) continue;
        args.push(v);
        sets.push(`${col} = $${args.length}`);
      }
      try {
        await c.query(`UPDATE merchants.capabilities SET ${[...sets, 'updated_by = $3', 'updated_at = now()'].join(', ')}
                        WHERE merchant_id = $1 AND key = $2`, args);
      } catch (e) {
        if ((e as { code?: string }).code === '23514') throw new ApiError(400, 'capability_invalid', 'Valores fuera de rango (comisión 0–10000 bps, mínimo ≤ máximo)');
        throw e;
      }
      return this.recordChange(c, merchantId, key, actor, before);
    });
  }

  /** Plataforma: interruptor global (emergencia) y si se le da a los comercios nuevos. */
  async platformSetGlobal(key: string, patch: { global_enabled?: unknown; default_for_new?: unknown }, actor: string) {
    for (const f of ['global_enabled', 'default_for_new'] as const) {
      if (patch[f] !== undefined && typeof patch[f] !== 'boolean') throw new ApiError(400, 'capability_invalid', `${f} debe ser true o false`, 'invalid_request_error', { param: f });
    }
    return withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ key: string; kind: string; global_enabled: boolean; default_for_new: boolean }>(
        'SELECT key, kind, global_enabled, default_for_new FROM platform.capabilities WHERE key = $1 FOR UPDATE', [key]);
      if (!rows[0]) throw new ApiError(404, 'resource_missing', `No existe la capacidad ${key}`);
      const after = {
        ...rows[0],
        global_enabled: (patch.global_enabled as boolean | undefined) ?? rows[0].global_enabled,
        default_for_new: (patch.default_for_new as boolean | undefined) ?? rows[0].default_for_new,
      };
      await c.query('UPDATE platform.capabilities SET global_enabled = $2, default_for_new = $3, updated_at = now() WHERE key = $1',
        [key, after.global_enabled, after.default_for_new]);
      await c.query('INSERT INTO merchants.capability_changes (merchant_id, key, actor, before, after) VALUES (NULL, $1, $2, $3, $4)',
        [key, actor, JSON.stringify(rows[0]), JSON.stringify(after)]);
      return after;
    });
  }

  /** Catálogo de plataforma con cuántos comercios tienen cada capacidad activa. */
  async listGlobal() {
    const { rows } = await this.pool.query<{ key: string; kind: 'method' | 'module'; global_enabled: boolean; default_for_new: boolean;
                                             merchants_active: number; pending: number }>(
      `SELECT pc.key, pc.kind, pc.global_enabled, pc.default_for_new,
              count(mc.merchant_id) FILTER (WHERE mc.platform_status = 'allowed' AND mc.merchant_enabled)::int AS merchants_active,
              count(mc.merchant_id) FILTER (WHERE mc.platform_status = 'pending_review')::int AS pending
         FROM platform.capabilities pc LEFT JOIN merchants.capabilities mc ON mc.key = pc.key
        GROUP BY pc.key`);
    const order = [...Object.keys(PAYMENT_METHODS), ...Object.keys(MODULE_NAMES)];
    const pos = (k: string) => (order.indexOf(k) + 1 || order.length + 1);
    return rows.sort((a, b) => pos(a.key) - pos(b.key)).map((r) => ({
      ...r, name: isPaymentMethodType(r.key) ? METHOD_NAMES[r.key] : MODULE_NAMES[r.key as ModuleKey] ?? r.key,
    }));
  }

  /** Bandeja del panel interno: solicitudes en revisión, las más viejas primero. */
  async pendingRequests() {
    const { rows } = await this.pool.query<{ merchant_id: string; key: string; requested_at: Date; requested_by: string;
                                             business_name: string; rif: string; merchant_status: string; kyc_submitted_at: Date | null }>(
      `SELECT mc.merchant_id, mc.key, mc.updated_at AS requested_at, mc.updated_by AS requested_by,
              m.business_name, m.rif, m.status AS merchant_status, m.kyc_submitted_at
         FROM merchants.capabilities mc JOIN merchants.merchants m ON m.id = mc.merchant_id
        WHERE mc.platform_status = 'pending_review' ORDER BY mc.updated_at, mc.merchant_id`);
    return rows.map((r) => ({ ...r, name: isPaymentMethodType(r.key) ? METHOD_NAMES[r.key] : MODULE_NAMES[r.key as ModuleKey] ?? r.key }));
  }

  private async lockRow(c: PoolClient, merchantId: string, key: string): Promise<CapabilityView> {
    const m = await c.query('SELECT 1 FROM merchants.merchants WHERE id = $1 FOR UPDATE', [merchantId]);
    if (m.rowCount === 0) throw new ApiError(404, 'resource_missing', `No existe el comercio ${merchantId}`);
    return this.get(c, merchantId, key);
  }

  /** Auditoría + webhook `account.capability.updated`, en la misma transacción que el cambio. */
  private async recordChange(c: PoolClient, merchantId: string, key: string, actor: string, before: CapabilityView): Promise<CapabilityView> {
    const after = await this.get(c, merchantId, key);
    await c.query('INSERT INTO merchants.capability_changes (merchant_id, key, actor, before, after) VALUES ($1, $2, $3, $4, $5)',
      [merchantId, key, actor, JSON.stringify(before), JSON.stringify(after)]);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await enqueueEvent(c, { merchantId, livemode: INSTANCE_LIVEMODE, type: 'account.capability.updated', objectId: key, object: after });
    }
    return after;
  }
}
