import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { ApiError } from '../common/errors';
import { Currency } from '../common/money';
import { PG_POOL } from '../database/database';

export type MerchantStatus = 'pending_kyc' | 'active' | 'restricted' | 'closed';

export interface AuthenticatedKey {
  merchantId: string;
  merchantStatus: MerchantStatus;
  kind: 'secret' | 'publishable';
  livemode: boolean;
}

export interface SettlementRule {
  targetCurrency: Currency;
  bps: number;
  destination: Record<string, unknown>;
}

const KEY_FORMAT = /^(sk|pk)_(live|test)_[A-Za-z0-9]{32}$/;

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

@Injectable()
export class MerchantsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(input: { businessName: string; rif: string; id?: string; webhookUrl?: string }) {
    const id = input.id ?? `acct_${randomBytes(8).toString('hex')}`;
    const webhookSecret = input.webhookUrl ? `whsec_${randomBytes(24).toString('hex')}` : null;
    await this.pool.query(
      `INSERT INTO merchants.merchants (id, business_name, rif, webhook_url, webhook_secret) VALUES ($1, $2, $3, $4, $5)`,
      [id, input.businessName, input.rif.toUpperCase(), input.webhookUrl ?? null, webhookSecret],
    );
    return { id, webhookSecret };
  }

  /** Lo que el pagador ve en el checkout: nombre comercial y RIF. */
  async publicProfile(merchantId: string): Promise<{ name: string; rif: string }> {
    const res = await this.pool.query<{ business_name: string; rif: string }>(
      'SELECT business_name, rif FROM merchants.merchants WHERE id = $1', [merchantId]);
    if (res.rowCount === 0) throw new ApiError(404, 'resource_missing', `No existe el comercio ${merchantId}`);
    return { name: res.rows[0].business_name, rif: res.rows[0].rif };
  }

  /** Aprobación de KYC (panel administrativo). Sin esto solo funcionan las llaves de prueba. */
  async setStatus(merchantId: string, status: MerchantStatus) {
    if (!['pending_kyc', 'active', 'restricted', 'closed'].includes(status)) {
      throw new ApiError(400, 'status_invalid', `Estado de comercio inválido: ${status}`);
    }
    const res = await this.pool.query('UPDATE merchants.merchants SET status = $2, updated_at = now() WHERE id = $1', [merchantId, status]);
    if (res.rowCount === 0) throw new ApiError(404, 'resource_missing', `No existe el comercio ${merchantId}`);
  }

  /** Devuelve la llave en claro UNA sola vez; en BD queda solo el hash. */
  async createApiKey(merchantId: string, kind: 'secret' | 'publishable', livemode: boolean) {
    const raw = `${kind === 'secret' ? 'sk' : 'pk'}_${livemode ? 'live' : 'test'}_${randomBytes(16).toString('hex')}`;
    const id = `key_${randomBytes(8).toString('hex')}`;
    await this.pool.query(
      `INSERT INTO merchants.api_keys (id, merchant_id, kind, livemode, key_hash, key_prefix, publishable_key) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, merchantId, kind, livemode, hashApiKey(raw), raw.slice(0, 12), kind === 'publishable' ? raw : null],
    );
    return { id, key: raw };
  }

  /** Llave publicable activa para armar URLs de checkout (links de pago, pagos creados desde el dashboard). */
  async ensurePublishableKey(merchantId: string, livemode: boolean): Promise<string> {
    const { rows } = await this.pool.query<{ publishable_key: string }>(
      `SELECT publishable_key FROM merchants.api_keys
        WHERE merchant_id = $1 AND kind = 'publishable' AND livemode = $2 AND is_active AND publishable_key IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`, [merchantId, livemode]);
    return rows[0]?.publishable_key ?? (await this.createApiKey(merchantId, 'publishable', livemode)).key;
  }

  async listApiKeys(merchantId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, kind, livemode, key_prefix AS prefix, publishable_key AS key, is_active AS active, last_used_at,
              created_at AS created, revoked_at
         FROM merchants.api_keys WHERE merchant_id = $1 ORDER BY is_active DESC, created_at DESC`, [merchantId]);
    return rows;
  }

  async apiKeyOwned(merchantId: string, keyId: string) {
    const { rows } = await this.pool.query<{ kind: 'secret' | 'publishable'; livemode: boolean; is_active: boolean }>(
      'SELECT kind, livemode, is_active FROM merchants.api_keys WHERE id = $1 AND merchant_id = $2', [keyId, merchantId]);
    if (!rows[0]) throw new ApiError(404, 'resource_missing', `No existe la llave ${keyId}`);
    return rows[0];
  }

  async get(merchantId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, business_name, rif, status, kyc_submitted_at, created_at AS created FROM merchants.merchants WHERE id = $1`, [merchantId]);
    if (!rows[0]) throw new ApiError(404, 'resource_missing', `No existe el comercio ${merchantId}`);
    return rows[0];
  }

  async updateProfile(merchantId: string, businessName: string) {
    const name = String(businessName ?? '').trim();
    if (name.length < 2 || name.length > 120) throw new ApiError(400, 'business_name_invalid', 'El nombre comercial debe tener entre 2 y 120 caracteres');
    await this.pool.query('UPDATE merchants.merchants SET business_name = $2, updated_at = now() WHERE id = $1', [merchantId, name]);
    return this.get(merchantId);
  }

  /** Datos para activar la cuenta. La aprobación (status = active) la hace el equipo de cumplimiento. */
  async submitKyc(merchantId: string, data: Record<string, unknown>) {
    const fields = ['legal_name', 'representative_name', 'representative_id', 'address', 'phone', 'bank_name', 'bank_account'];
    const clean: Record<string, string> = {};
    for (const f of fields) {
      const v = typeof data[f] === 'string' ? (data[f] as string).trim() : '';
      if (!v || v.length > 200) throw new ApiError(400, 'kyc_invalid', `Falta o es inválido el campo ${f}`, 'invalid_request_error', { param: f });
      clean[f] = v;
    }
    if (!/^\d{20}$/.test(clean.bank_account.replace(/[\s-]/g, ''))) {
      throw new ApiError(400, 'kyc_invalid', 'La cuenta bancaria debe tener 20 dígitos', 'invalid_request_error', { param: 'bank_account' });
    }
    await this.pool.query(
      `UPDATE merchants.merchants SET kyc_data = $2, kyc_submitted_at = now(), updated_at = now() WHERE id = $1`,
      [merchantId, JSON.stringify(clean)]);
    return this.get(merchantId);
  }

  async revokeApiKey(merchantId: string, keyId: string) {
    await this.pool.query(
      `UPDATE merchants.api_keys SET is_active = false, revoked_at = now() WHERE id = $1 AND merchant_id = $2`, [keyId, merchantId]);
  }

  /** null si la llave no existe, está revocada o tiene formato inválido. */
  async authenticate(raw: string): Promise<AuthenticatedKey | null> {
    if (!KEY_FORMAT.test(raw)) return null;
    const res = await this.pool.query<{ merchant_id: string; status: MerchantStatus; kind: 'secret' | 'publishable'; livemode: boolean }>(
      `UPDATE merchants.api_keys k SET last_used_at = now()
         FROM merchants.merchants m
        WHERE k.key_hash = $1 AND k.is_active AND m.id = k.merchant_id
       RETURNING k.merchant_id, m.status, k.kind, k.livemode`,
      [hashApiKey(raw)],
    );
    const r = res.rows[0];
    return r ? { merchantId: r.merchant_id, merchantStatus: r.status, kind: r.kind, livemode: r.livemode } : null;
  }

  /** Reemplaza la regla de split del comercio para una moneda origen (p. ej. VES → 60 % VES + 40 % USDT). */
  async setSettlementRules(merchantId: string, sourceCurrency: Currency, rules: SettlementRule[]) {
    const total = rules.reduce((s, r) => s + r.bps, 0);
    if (total !== 10_000) throw new ApiError(400, 'settlement_rules_invalid', `Los porcentajes deben sumar 100 % (suman ${total / 100} %)`);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM merchants.settlement_rules WHERE merchant_id = $1 AND source_currency = $2', [merchantId, sourceCurrency]);
      for (const r of rules) {
        await client.query(
          `INSERT INTO merchants.settlement_rules (merchant_id, source_currency, target_currency, bps, destination) VALUES ($1, $2, $3, $4, $5)`,
          [merchantId, sourceCurrency, r.targetCurrency, r.bps, JSON.stringify(r.destination)],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
