import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool, PoolClient } from 'pg';
import { ApiError } from '../common/errors';
import { REDIS } from '../common/idempotency.interceptor';
import { PG_POOL, withTransaction } from '../database/database';
import { vault } from '../secrets/vault';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from './totp';

/** Quién tiene el doble factor: un usuario del panel del comercio o un operador del panel interno. */
export interface MfaPrincipal {
  type: 'user' | 'operator';
  id: string;
  /** Lo que la app autenticadora muestra junto a "Paguara" (correo o nombre). */
  label: string;
}

/** Fallos de código seguidos por persona antes de bloquear 15 minutos. */
const MAX_FAILS = 5;
const purpose = (p: MfaPrincipal) => `mfa:${p.type}:${p.id}`;

/**
 * Doble factor compartido por los dos paneles: semilla TOTP cifrada con el KMS,
 * 10 códigos de respaldo de un solo uso (solo su SHA-256) y auditoría append-only
 * de cada alta, baja y reinicio.
 */
@Injectable()
export class MfaService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(REDIS) private readonly redis: Redis) {}

  async status(p: MfaPrincipal) {
    const { rows } = await this.pool.query<{ confirmed_at: Date | null; left: number }>(
      `SELECT f.confirmed_at,
              (SELECT count(*)::int FROM security.mfa_recovery_codes r
                WHERE r.principal_type = f.principal_type AND r.principal_id = f.principal_id AND r.used_at IS NULL) AS left
         FROM security.mfa_factors f WHERE f.principal_type = $1 AND f.principal_id = $2`, [p.type, p.id]);
    const f = rows[0];
    return { enabled: !!f?.confirmed_at, enabled_at: f?.confirmed_at ?? null, recovery_codes_left: f?.confirmed_at ? f.left : 0 };
  }

  async isEnabled(p: MfaPrincipal): Promise<boolean> {
    return (await this.status(p)).enabled;
  }

  /** Paso 1: semilla nueva (reemplaza una inscripción a medias). Devuelve lo que se muestra en el QR. */
  async beginEnrollment(p: MfaPrincipal) {
    if (await this.isEnabled(p)) throw new ApiError(409, 'mfa_already_enabled', 'El doble factor ya está activo. Para cambiar de teléfono, quítalo y vuelve a activarlo.');
    const secret = newTotpSecret();
    await this.pool.query(
      `INSERT INTO security.mfa_factors (principal_type, principal_id, secret_sealed) VALUES ($1, $2, $3)
       ON CONFLICT (principal_type, principal_id) DO UPDATE SET secret_sealed = EXCLUDED.secret_sealed, last_used_step = NULL, created_at = now()
       WHERE security.mfa_factors.confirmed_at IS NULL`,
      [p.type, p.id, await vault().seal(secret, purpose(p))]);
    return { secret, otpauth_url: otpauthUrl(secret, p.label) };
  }

  /** Paso 2: el primer código de la app confirma que la semilla quedó bien guardada. Devuelve los códigos de respaldo (se ven una vez). */
  async confirmEnrollment(p: MfaPrincipal, code: string, actor: string): Promise<{ recovery_codes: string[] }> {
    await this.assertNotLocked(p);
    return withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ secret_sealed: string; confirmed_at: Date | null }>(
        'SELECT secret_sealed, confirmed_at FROM security.mfa_factors WHERE principal_type = $1 AND principal_id = $2 FOR UPDATE', [p.type, p.id]);
      if (!rows[0]) throw new ApiError(409, 'mfa_enrollment_missing', 'Primero genera el código QR para tu app autenticadora');
      if (rows[0].confirmed_at) throw new ApiError(409, 'mfa_already_enabled', 'El doble factor ya está activo');
      const step = verifyTotp(await vault().open(rows[0].secret_sealed, purpose(p)), (code ?? '').trim());
      if (step === null) { await this.fail(p); throw invalidCode(); }
      await c.query(
        'UPDATE security.mfa_factors SET confirmed_at = now(), last_used_step = $3 WHERE principal_type = $1 AND principal_id = $2', [p.type, p.id, step]);
      const codes = await this.replaceRecoveryCodes(c, p);
      await audit(c, p, 'enrolled', actor);
      return { recovery_codes: codes };
    });
  }

  /**
   * Verifica un código de la app (6 dígitos) o un código de respaldo. El mismo
   * código TOTP no vale dos veces y un código de respaldo se gasta al usarlo.
   * 5 fallos seguidos bloquean 15 minutos (429).
   */
  async verify(p: MfaPrincipal, rawCode: string, actor: string): Promise<'totp' | 'recovery_code'> {
    await this.assertNotLocked(p);
    const code = (rawCode ?? '').trim();
    const method = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ secret_sealed: string; last_used_step: bigint | null }>(
        `SELECT secret_sealed, last_used_step FROM security.mfa_factors
          WHERE principal_type = $1 AND principal_id = $2 AND confirmed_at IS NOT NULL FOR UPDATE`, [p.type, p.id]);
      if (!rows[0]) throw new ApiError(409, 'mfa_not_enabled', 'Esta cuenta no tiene doble factor');
      if (/^\d{6}$/.test(code)) {
        const last = rows[0].last_used_step === null ? null : Number(rows[0].last_used_step);
        const step = verifyTotp(await vault().open(rows[0].secret_sealed, purpose(p)), code, { afterStep: last });
        if (step === null) return null;
        await c.query('UPDATE security.mfa_factors SET last_used_step = $3 WHERE principal_type = $1 AND principal_id = $2', [p.type, p.id, step]);
        return 'totp' as const;
      }
      if (!normalizeRecoveryCode(code)) return null;
      const used = await c.query(
        `UPDATE security.mfa_recovery_codes SET used_at = now()
          WHERE principal_type = $1 AND principal_id = $2 AND code_hash = $3 AND used_at IS NULL`, [p.type, p.id, hashRecoveryCode(code)]);
      if (used.rowCount === 0) return null;
      await audit(c, p, 'recovery_code_used', actor);
      return 'recovery_code' as const;
    });
    if (!method) { await this.fail(p); throw invalidCode(); }
    await this.redis.del(failKey(p));
    return method;
  }

  /** La persona quita su doble factor (pide un código vigente) o un maestro lo reinicia (con motivo). */
  async remove(p: MfaPrincipal, actor: string, action: 'disabled' | 'reset', reason?: string) {
    await withTransaction(this.pool, async (c) => {
      const del = await c.query('DELETE FROM security.mfa_factors WHERE principal_type = $1 AND principal_id = $2', [p.type, p.id]);
      await c.query('DELETE FROM security.mfa_recovery_codes WHERE principal_type = $1 AND principal_id = $2', [p.type, p.id]);
      if (del.rowCount === 0 && action === 'reset') throw new ApiError(409, 'mfa_not_enabled', 'Esa persona no tiene doble factor');
      await audit(c, p, action, actor, reason);
    });
    await this.redis.del(failKey(p));
  }

  async regenerateRecoveryCodes(p: MfaPrincipal, actor: string) {
    return withTransaction(this.pool, async (c) => {
      const codes = await this.replaceRecoveryCodes(c, p);
      await audit(c, p, 'recovery_codes_regenerated', actor);
      return { recovery_codes: codes };
    });
  }

  private async replaceRecoveryCodes(c: PoolClient, p: MfaPrincipal) {
    const codes = newRecoveryCodes();
    await c.query('DELETE FROM security.mfa_recovery_codes WHERE principal_type = $1 AND principal_id = $2', [p.type, p.id]);
    for (const code of codes) {
      await c.query('INSERT INTO security.mfa_recovery_codes (principal_type, principal_id, code_hash) VALUES ($1, $2, $3)',
        [p.type, p.id, hashRecoveryCode(code)]);
    }
    return codes;
  }

  private async assertNotLocked(p: MfaPrincipal) {
    if (Number(await this.redis.get(failKey(p))) >= MAX_FAILS) {
      throw new ApiError(429, 'too_many_attempts', 'Demasiados códigos incorrectos. Espera 15 minutos.');
    }
  }

  private async fail(p: MfaPrincipal) {
    await this.redis.multi().incr(failKey(p)).expire(failKey(p), 15 * 60).exec();
  }
}

const failKey = (p: MfaPrincipal) => `mfa:fail:${p.type}:${p.id}`;
const invalidCode = () => new ApiError(401, 'mfa_code_invalid', 'El código no es válido o ya se usó. Escribe el de 6 dígitos que muestra tu app ahora, o un código de respaldo.');

function audit(c: PoolClient, p: MfaPrincipal, action: string, actor: string, reason?: string) {
  return c.query('INSERT INTO security.mfa_audit (principal_type, principal_id, action, actor, reason) VALUES ($1, $2, $3, $4, $5)',
    [p.type, p.id, action, actor, reason ?? null]);
}
