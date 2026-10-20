import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { ApiError } from '../common/errors';
import { PG_POOL, withTransaction } from '../database/database';
import type { Operator } from './settlements.service';

const TOKEN_FORMAT = /^opk_[a-f0-9]{48}$/;
const SESSION_FORMAT = /^ops_[A-Za-z0-9_-]{43}$/;
/** Horas que dura una sesión del panel interno (después hay que volver a poner el código). */
export const operatorSessionHours = (env: NodeJS.ProcessEnv = process.env) => {
  const h = Number(env.OPERATOR_SESSION_HOURS ?? 8);
  return Number.isFinite(h) && h > 0 && h <= 24 ? h : 8;
};
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Personas del panel interno (migración 010). Cada una tiene su propio token
 * (`opk_…`, en la base solo su SHA-256), así la auditoría dice quién fue y una
 * liquidación puede exigir aprobaciones de personas distintas.
 *
 * Desde la migración 012 el token solo no abre /internal: con él y el código de
 * su app autenticadora la persona recibe una sesión `ops_…` de pocas horas
 * (InternalAuthController). Revocar a la persona cierra sus sesiones.
 */
@Injectable()
export class OperatorsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async startSession(operatorId: string, ip: string | null): Promise<{ session: string; expires_at: Date }> {
    const session = `ops_${randomBytes(32).toString('base64url')}`;
    const { rows } = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO platform.operator_sessions (token_hash, operator_id, expires_at, ip)
       VALUES ($1, $2, now() + make_interval(hours => $3), $4) RETURNING expires_at`,
      [hash(session), operatorId, operatorSessionHours(), ip]);
    return { session, expires_at: rows[0].expires_at };
  }

  async authenticateSession(session: string): Promise<Operator | null> {
    if (!SESSION_FORMAT.test(session)) return null;
    const { rows } = await this.pool.query<Operator>(
      `SELECT o.id, o.name, o.role FROM platform.operator_sessions s JOIN platform.operators o ON o.id = s.operator_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND o.revoked_at IS NULL`, [hash(session)]);
    return rows[0] ?? null;
  }

  async endSession(session: string) {
    await this.pool.query('UPDATE platform.operator_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hash(session)]);
  }

  async endAllSessions(operatorId: string) {
    await this.pool.query('UPDATE platform.operator_sessions SET revoked_at = now() WHERE operator_id = $1 AND revoked_at IS NULL', [operatorId]);
  }

  async get(id: string): Promise<Operator> {
    const { rows } = await this.pool.query<Operator>('SELECT id, name, role FROM platform.operators WHERE id = $1 AND revoked_at IS NULL', [id]);
    if (!rows[0]) throw new ApiError(404, 'resource_missing', `No existe el operador activo ${id}`);
    return rows[0];
  }

  async authenticate(token: string): Promise<Operator | null> {
    if (!TOKEN_FORMAT.test(token)) return null;
    const { rows } = await this.pool.query<Operator>(
      'SELECT id, name, role FROM platform.operators WHERE token_hash = $1 AND revoked_at IS NULL', [hash(token)]);
    return rows[0] ?? null;
  }

  /**
   * Alta de una persona; el token en claro se devuelve solo aquí. Con el token de
   * sistema solo se puede crear al primer maestro (arranque); después, solo un maestro crea operadores.
   */
  create(input: { name?: unknown; role?: unknown }, by: Operator | 'system') {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 2 || name.length > 60) throw new ApiError(400, 'name_invalid', 'El nombre debe tener entre 2 y 60 caracteres');
    if (input.role !== 'master' && input.role !== 'operator') throw new ApiError(400, 'role_invalid', 'role debe ser master u operator');
    return withTransaction(this.pool, async (c) => {
      if (by === 'system') {
        await c.query('LOCK TABLE platform.operators IN EXCLUSIVE MODE');
        const { rowCount } = await c.query(`SELECT 1 FROM platform.operators WHERE role = 'master' AND revoked_at IS NULL`);
        if (rowCount) throw new ApiError(403, 'insufficient_role', 'Ya hay un maestro: los operadores los crea un maestro');
        if (input.role !== 'master') throw new ApiError(403, 'insufficient_role', 'Con el token de sistema solo se crea el primer maestro');
      } else if (by.role !== 'master') {
        throw new ApiError(403, 'insufficient_role', 'Solo un maestro crea operadores');
      }
      const id = `op_${randomBytes(8).toString('hex')}`;
      const token = `opk_${randomBytes(24).toString('hex')}`;
      try {
        await c.query('INSERT INTO platform.operators (id, name, role, token_hash, created_by) VALUES ($1, $2, $3, $4, $5)',
          [id, name, input.role, hash(token), by === 'system' ? 'system' : by.id]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ApiError(409, 'name_taken', `Ya existe un operador llamado ${name}`);
        throw e;
      }
      return { id, name, role: input.role as Operator['role'], token };
    });
  }

  async revoke(id: string, by: Operator) {
    if (by.role !== 'master') throw new ApiError(403, 'insufficient_role', 'Solo un maestro revoca operadores');
    if (id === by.id) throw new ApiError(409, 'cannot_revoke_self', 'No puedes revocarte a ti mismo');
    const res = await this.pool.query('UPDATE platform.operators SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
    if (res.rowCount === 0) throw new ApiError(404, 'resource_missing', `No existe el operador activo ${id}`);
    await this.endAllSessions(id);
    return { id, revoked: true };
  }

  async list() {
    const { rows } = await this.pool.query(
      `SELECT o.id, o.name, o.role, o.created_at, o.revoked_at, (f.confirmed_at IS NOT NULL) AS mfa_enabled
         FROM platform.operators o
         LEFT JOIN security.mfa_factors f ON f.principal_type = 'operator' AND f.principal_id = o.id
        ORDER BY o.revoked_at NULLS FIRST, o.name`);
    return rows;
  }
}
