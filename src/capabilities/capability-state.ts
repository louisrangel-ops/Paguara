import { Pool, PoolClient } from 'pg';
import { ApiError } from '../common/errors';
import { METHOD_NAMES, MethodConfig, PAYMENT_METHODS, PaymentMethodType, isPaymentMethodType } from '../payment-intents/payment-methods';

/**
 * Interruptores por comercio (migración 008). La regla que combina plataforma y
 * comercio está en SQL (merchants.capability_state); aquí solo se lee y se escribe.
 */
export type CapabilityState = 'unavailable' | 'not_granted' | 'pending_review' | 'blocked' | 'disabled' | 'active';
export type ModuleKey = 'payment_links' | 'webhooks' | 'settlement_usdt' | 'settlement_usd';
export type Db = Pool | PoolClient;

export const MODULE_NAMES: Record<ModuleKey, string> = {
  payment_links: 'Links de pago', webhooks: 'Webhooks',
  settlement_usdt: 'Liquidar en USDT', settlement_usd: 'Liquidar en dólares',
};

/** Módulo que exige convertir una liquidación de `source` a `target` (a bolívares o sin conversión: ninguno). */
export function settlementModuleFor(source: string, target: string): ModuleKey | null {
  if (source === target) return null;
  if (target === 'USDT') return 'settlement_usdt';
  if (target === 'USD') return 'settlement_usd';
  return null;
}

export interface CapabilityRow {
  key: string;
  kind: 'method' | 'module';
  state: CapabilityState;
  merchant_enabled: boolean | null;
  fee_bps: number | null;
  fee_fixed_usd: string | null;
  min_amount: string | null;
  max_amount: string | null;
}

export const ROWS = `
  SELECT pc.key, pc.kind, merchants.capability_state($1, pc.key) AS state, mc.merchant_enabled,
         mc.fee_bps, mc.fee_fixed_usd::text, mc.min_amount::text, mc.max_amount::text
    FROM platform.capabilities pc
    LEFT JOIN merchants.capabilities mc ON mc.merchant_id = $1 AND mc.key = pc.key`;

export interface MethodSettings {
  type: PaymentMethodType;
  state: CapabilityState;
  /** Precios de plataforma con los del comercio encima. */
  cfg: MethodConfig;
  minAmount: bigint | null;
  maxAmount: bigint | null;
}

export function toSettings(r: CapabilityRow): MethodSettings {
  const type = r.key as PaymentMethodType;
  const base = PAYMENT_METHODS[type];
  return {
    type,
    state: r.state,
    cfg: {
      ...base,
      feeBps: r.fee_bps ?? base.feeBps,
      feeFixedUsd: r.fee_fixed_usd !== null ? BigInt(r.fee_fixed_usd) : base.feeFixedUsd,
    },
    minAmount: r.min_amount !== null ? BigInt(r.min_amount) : null,
    maxAmount: r.max_amount !== null ? BigInt(r.max_amount) : null,
  };
}

/** Configuración efectiva de cada método para el comercio (todos, activos o no). */
export async function methodSettings(db: Db, merchantId: string): Promise<MethodSettings[]> {
  const { rows } = await db.query<CapabilityRow>(`${ROWS} WHERE pc.kind = 'method' ORDER BY pc.key`, [merchantId]);
  return rows.filter((r) => isPaymentMethodType(r.key)).map(toSettings);
}

/** Métodos que el pagador puede usar en este pago: activos y, si el pago trae lista, dentro de ella. */
export function allowedFor(all: MethodSettings[], only: string[] | null): MethodSettings[] {
  return all.filter((m) => m.state === 'active' && (!only || only.includes(m.type)));
}

export async function moduleState(db: Db, merchantId: string, key: ModuleKey): Promise<CapabilityState> {
  const { rows } = await db.query<{ state: CapabilityState }>('SELECT merchants.capability_state($1, $2) AS state', [merchantId, key]);
  return rows[0].state;
}

export async function assertModuleActive(db: Db, merchantId: string, key: ModuleKey) {
  const state = await moduleState(db, merchantId, key);
  if (state !== 'active') {
    throw new ApiError(403, 'feature_disabled', `${MODULE_NAMES[key]} no está activo en esta cuenta (${STATE_TEXT[state]})`,
      'invalid_request_error', { capability: key, state });
  }
}

export const STATE_TEXT: Record<CapabilityState, string> = {
  unavailable: 'no disponible por ahora',
  not_granted: 'no habilitado para tu cuenta',
  pending_review: 'en revisión',
  blocked: 'bloqueado por Paguara',
  disabled: 'apagado por el comercio',
  active: 'activo',
};

/** Valida una lista de métodos que manda el comercio (pago o link). null = todos los activos. */
export function parseMethodList(v: unknown): PaymentMethodType[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length === 0 || v.length > Object.keys(PAYMENT_METHODS).length) {
    throw new ApiError(400, 'payment_method_types_invalid', 'payment_method_types debe ser una lista no vacía de métodos', 'invalid_request_error', { param: 'payment_method_types' });
  }
  const bad = v.find((t) => !isPaymentMethodType(t));
  if (bad !== undefined) {
    throw new ApiError(400, 'payment_method_invalid', `Método no soportado: ${String(bad)}`, 'invalid_request_error', { param: 'payment_method_types' });
  }
  return [...new Set(v as PaymentMethodType[])];
}


/** Lo que el checkout necesita para pintar cada método y su precio. */
export function methodView(m: MethodSettings) {
  return {
    type: m.type, name: METHOD_NAMES[m.type], currency: m.cfg.chargeCurrency, fee_bps: m.cfg.feeBps,
    fixed_usd: m.cfg.feeFixedUsd.toString(), tax_bps: m.cfg.feeTaxBps, igtf_bps: m.cfg.igtfBps, quote_ttl_seconds: m.cfg.quoteTtlSeconds,
  };
}
