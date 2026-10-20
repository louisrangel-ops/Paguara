import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { ApiError } from '../common/errors';
import { Currency } from '../common/money';
import { PG_POOL, withTransaction } from '../database/database';
import { grantSandboxMethods } from '../capabilities/capability-state';
import { sealSecret } from '../common/secret-box';

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
    await withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO merchants.merchants (id, business_name, rif, webhook_url, webhook_secret) VALUES ($1, $2, $3, $4, $5)`,
        [id, input.businessName, input.rif.toUpperCase(), input.webhookUrl ?? null, webhookSecret && sealSecret(webhookSecret)],
      );
      await grantSandboxMethods(c, id);
    });
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
      `SELECT m.id, m.business_name, m.rif, m.status, m.kyc_submitted_at, m.created_at AS created,
              COALESCE(i.status, 'pending') AS iso8583_profile_status
         FROM merchants.merchants m
         LEFT JOIN merchants.iso8583_profiles i ON i.merchant_id = m.id
        WHERE m.id = $1`, [merchantId]);
    if (!rows[0]) throw new ApiError(404, 'resource_missing', `No existe el comercio ${merchantId}`);
    return rows[0];
  }

  async listForAdmin(q = '', status = '', limit = 50) {
    const term = String(q ?? '').trim();
    const st = String(status ?? '').trim();
    const n = Math.max(1, Math.min(100, Number(limit) || 50));
    if (st && !['pending_kyc','active','restricted','closed'].includes(st)) {
      throw new ApiError(400, 'status_invalid', 'Estado de comercio inválido');
    }
    const { rows } = await this.pool.query(
      `SELECT m.id, m.business_name, m.rif, m.status, m.kyc_submitted_at, m.created_at AS created,
              COALESCE(i.status, 'pending') AS iso8583_profile_status
         FROM merchants.merchants m
         LEFT JOIN merchants.iso8583_profiles i ON i.merchant_id = m.id
        WHERE ($1 = '' OR m.id ILIKE '%' || $1 || '%' OR m.business_name ILIKE '%' || $1 || '%' OR m.rif ILIKE '%' || $1 || '%')
          AND ($2 = '' OR m.status = $2)
        ORDER BY m.created_at DESC
        LIMIT $3`,
      [term, st, n]);
    return rows;
  }

  /** Vista interna para revisión KYC/provisionamiento. Nunca se expone al checkout. */
  async getForReview(merchantId: string) {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.business_name, m.rif, m.status, m.kyc_data, m.kyc_submitted_at, m.created_at AS created,
              i.status AS iso8583_status, i.mcc, i.acquirer_merchant_id, i.terminal_id,
              i.acquiring_institution_id, i.currency_numeric, i.pos_entry_mode, i.pos_condition_code
         FROM merchants.merchants m
         LEFT JOIN merchants.iso8583_profiles i ON i.merchant_id = m.id
        WHERE m.id = $1`, [merchantId]);
    if (!rows[0]) throw new ApiError(404, 'resource_missing', `No existe el comercio ${merchantId}`);
    return rows[0];
  }

  async updateProfile(merchantId: string, businessName: string) {
    const name = String(businessName ?? '').trim();
    if (name.length < 2 || name.length > 120) throw new ApiError(400, 'business_name_invalid', 'El nombre comercial debe tener entre 2 y 120 caracteres');
    await this.pool.query('UPDATE merchants.merchants SET business_name = $2, updated_at = now() WHERE id = $1', [merchantId, name]);
    return this.get(merchantId);
  }

  /** Datos para activar la cuenta y perfilar e-commerce. No recibe datos de tarjetas. */
  async submitKyc(merchantId: string, data: Record<string, unknown>) {
    const value = (key: string, max = 200) => {
      const v = typeof data[key] === 'string' ? (data[key] as string).trim() : '';
      if (!v || v.length > max) throw new ApiError(400, 'kyc_invalid', `Falta o es inválido el campo ${key}`, 'invalid_request_error', { param: key });
      return v;
    };
    const optional = (key: string, max = 200) => {
      const v = typeof data[key] === 'string' ? (data[key] as string).trim() : '';
      if (v.length > max) throw new ApiError(400, 'kyc_invalid', `Es inválido el campo ${key}`, 'invalid_request_error', { param: key });
      return v || undefined;
    };

    const clean: Record<string, string> = {
      legal_name: value('legal_name', 120),
      representative_name: value('representative_name', 120),
      representative_id: value('representative_id', 16).toUpperCase(),
      address_line1: value('address_line1', 160),
      city: value('city', 64),
      state: value('state', 64),
      country_code: value('country_code', 2).toUpperCase(),
      phone: value('phone', 32),
      support_email: value('support_email', 160).toLowerCase(),
      business_activity: value('business_activity', 160),
      ecommerce_url: value('ecommerce_url', 240),
      statement_descriptor: value('statement_descriptor', 22),
      bank_name: value('bank_name', 120),
      bank_account: value('bank_account', 32).replace(/[\s-]/g, ''),
    };
    for (const [k, max] of [['address_line2', 160], ['postal_code', 16], ['website', 240]] as const) {
      const v = optional(k, max);
      if (v) clean[k] = v;
    }

    if (!/^[VE]-?\d{6,9}$/i.test(clean.representative_id)) {
      throw new ApiError(400, 'kyc_invalid', 'La cédula del representante no es válida', 'invalid_request_error', { param: 'representative_id' });
    }
    if (!/^[A-Z]{2}$/.test(clean.country_code)) {
      throw new ApiError(400, 'kyc_invalid', 'country_code debe usar ISO 3166-1 alpha-2, por ejemplo VE', 'invalid_request_error', { param: 'country_code' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean.support_email)) {
      throw new ApiError(400, 'kyc_invalid', 'El correo de soporte no es válido', 'invalid_request_error', { param: 'support_email' });
    }
    for (const field of ['ecommerce_url', 'website']) {
      if (!clean[field]) continue;
      try {
        const u = new URL(clean[field]);
        if (u.protocol !== 'https:') throw new Error();
      } catch {
        throw new ApiError(400, 'kyc_invalid', `${field} debe ser una URL https válida`, 'invalid_request_error', { param: field });
      }
    }
    if (!/^[\x20-\x7e]{5,22}$/.test(clean.statement_descriptor) || !/[A-Za-z]/.test(clean.statement_descriptor)) {
      throw new ApiError(400, 'kyc_invalid', 'El descriptor debe tener 5 a 22 caracteres imprimibles y al menos una letra', 'invalid_request_error', { param: 'statement_descriptor' });
    }
    if (!/^\d{20}$/.test(clean.bank_account)) {
      throw new ApiError(400, 'kyc_invalid', 'La cuenta bancaria debe tener 20 dígitos', 'invalid_request_error', { param: 'bank_account' });
    }

    // Alias legible para procesos existentes y revisión humana.
    clean.address = [clean.address_line1, clean.address_line2, clean.city, clean.state, clean.postal_code, clean.country_code].filter(Boolean).join(', ');

    await this.pool.query(
      `UPDATE merchants.merchants SET kyc_data = $2, kyc_submitted_at = now(), updated_at = now() WHERE id = $1`,
      [merchantId, JSON.stringify(clean)]);
    return this.get(merchantId);
  }

  /** Identificadores ISO 8583 asignados por el adquirente/plataforma; el comercio no puede fijarlos. */
  async setIso8583Profile(merchantId: string, data: Record<string, unknown>) {
    await this.get(merchantId);
    const text = (key: string, pattern: RegExp, required = true) => {
      const v = typeof data[key] === 'string' ? (data[key] as string).trim() : '';
      if ((!v && required) || (v && !pattern.test(v))) {
        throw new ApiError(400, 'iso8583_profile_invalid', `Campo ISO 8583 inválido: ${key}`, 'invalid_request_error', { param: key });
      }
      return v || null;
    };
    const status = text('status', /^(pending|provisioned|suspended)$/, false) ?? 'pending';
    const mcc = text('mcc', /^\d{4}$/);
    const mid = text('acquirer_merchant_id', /^[\x20-\x7e]{1,15}$/);
    const tid = text('terminal_id', /^[\x20-\x7e]{1,8}$/);
    const acquirer = text('acquiring_institution_id', /^\d{1,11}$/);
    const currencyNumeric = text('currency_numeric', /^\d{3}$/, false) ?? '928';
    const posEntryMode = text('pos_entry_mode', /^\d{3}$/, false) ?? '090';
    const posConditionCode = text('pos_condition_code', /^\d{2}$/, false) ?? '59';

    await this.pool.query(
      `INSERT INTO merchants.iso8583_profiles
         (merchant_id, status, mcc, acquirer_merchant_id, terminal_id, acquiring_institution_id, currency_numeric, pos_entry_mode, pos_condition_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (merchant_id) DO UPDATE SET
         status=EXCLUDED.status, mcc=EXCLUDED.mcc, acquirer_merchant_id=EXCLUDED.acquirer_merchant_id,
         terminal_id=EXCLUDED.terminal_id, acquiring_institution_id=EXCLUDED.acquiring_institution_id,
         currency_numeric=EXCLUDED.currency_numeric, pos_entry_mode=EXCLUDED.pos_entry_mode,
         pos_condition_code=EXCLUDED.pos_condition_code, updated_at=now()`,
      [merchantId, status, mcc, mid, tid, acquirer, currencyNumeric, posEntryMode, posConditionCode]);
    return this.getForReview(merchantId);
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

  /**
   * Cuenta a la que se liquida lo cobrado en una moneda. Por ley se le paga al
   * comercio en bolívares: una sola regla, VES al 100 %; lo cobrado en USD o
   * USDT se convierte en el corte (la base también lo exige, migración 010).
   */
  async setSettlementRules(merchantId: string, sourceCurrency: Currency, rules: SettlementRule[]) {
    if (rules.length !== 1 || rules[0].targetCurrency !== 'VES') {
      throw new ApiError(400, 'settlement_currency_invalid', 'Las liquidaciones se pagan solo en bolívares: indica una cuenta en VES');
    }
    if (rules[0].bps !== 10_000) throw new ApiError(400, 'settlement_rules_invalid', `La cuenta en bolívares recibe el 100 % (indicaste ${rules[0].bps / 100} %)`);
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
