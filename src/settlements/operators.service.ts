import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { ApiError } from '../common/errors';
import { PG_POOL, withTransaction } from '../database/database';
import type { Operator, OperatorRole } from './settlements.service';

const TOKEN_FORMAT = /^opk_[a-f0-9]{48}$/;
const ROLES: OperatorRole[] = ['master','operator','compliance','operations','treasury','support','auditor'];
export type OperatorPermission =
  | 'operators:read' | 'operators:manage'
  | 'merchants:read' | 'merchants:manage' | 'merchants:status' | 'merchants:api_keys'
  | 'iso8583:manage'
  | 'capabilities:read' | 'capabilities:manage' | 'platform:manage'
  | 'payouts:read' | 'payouts:approve'
  | 'settlement:manage' | 'treasury:contribute'
  | 'workers:run';

const PERMISSIONS: Record<OperatorRole, readonly OperatorPermission[]> = {
  master: ['operators:read','operators:manage','merchants:read','merchants:manage','merchants:status','merchants:api_keys','iso8583:manage','capabilities:read','capabilities:manage','platform:manage','payouts:read','payouts:approve','settlement:manage','treasury:contribute','workers:run'],
  operator: ['merchants:read','capabilities:read','payouts:read','payouts:approve'],
  compliance: ['merchants:read','merchants:status','iso8583:manage','capabilities:read'],
  operations: ['merchants:read','merchants:manage','capabilities:read','capabilities:manage','platform:manage'],
  treasury: ['merchants:read','payouts:read','payouts:approve','settlement:manage','treasury:contribute'],
  support: ['merchants:read','capabilities:read'],
  auditor: ['operators:read','merchants:read','capabilities:read','payouts:read'],
};

export const operatorPermissions = (role: OperatorRole): OperatorPermission[] => [...PERMISSIONS[role]];
export const hasOperatorPermission = (operator: Operator, permission: OperatorPermission) =>
  PERMISSIONS[operator.role]?.includes(permission) === true;

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Personas del panel interno (migración 010). Cada una tiene su propio token
 * (`opk_…`, en la base solo su SHA-256), así la auditoría dice quién fue y una
 * liquidación puede exigir aprobaciones de personas distintas.
 */
@Injectable()
export class OperatorsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

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
    if (!ROLES.includes(input.role as OperatorRole)) throw new ApiError(400, 'role_invalid', 'Rol interno inválido');
    return withTransaction(this.pool, async (c) => {
      if (by === 'system') {
        await c.query('LOCK TABLE platform.operators IN EXCLUSIVE MODE');
        const { rowCount } = await c.query(`SELECT 1 FROM platform.operators WHERE role = 'master' AND revoked_at IS NULL`);
        if (rowCount) throw new ApiError(403, 'insufficient_role', 'Ya hay un maestro: los operadores los crea un maestro');
        if (input.role !== 'master') throw new ApiError(403, 'insufficient_role', 'Con el token de sistema solo se crea el primer maestro');
      } else if (!hasOperatorPermission(by, 'operators:manage')) {
        throw new ApiError(403, 'insufficient_role', 'No tienes permiso para crear operadores');
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

  async changeRole(id: string, role: OperatorRole, by: Operator) {
    if (!hasOperatorPermission(by, 'operators:manage')) throw new ApiError(403, 'insufficient_role', 'No tienes permiso para cambiar roles');
    if (!ROLES.includes(role)) throw new ApiError(400, 'role_invalid', 'Rol interno inválido');
    if (id === by.id) throw new ApiError(409, 'cannot_change_own_role', 'No puedes cambiar tu propio rol');
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ role: OperatorRole; revoked_at: Date | null }>(
        'SELECT role, revoked_at FROM platform.operators WHERE id = $1 FOR UPDATE', [id]);
      const current = rows[0];
      if (!current || current.revoked_at) throw new ApiError(404, 'resource_missing', `No existe el operador activo ${id}`);
      if (current.role === role) return { id, role };
      if (current.role === 'master' && role !== 'master') {
        const masters = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM platform.operators WHERE role = 'master' AND revoked_at IS NULL`);
        if (masters.rows[0].n <= 1) throw new ApiError(409, 'last_master', 'Debe quedar al menos un maestro activo');
      }
      await client.query('UPDATE platform.operators SET role = $2 WHERE id = $1', [id, role]);
      await client.query(
        'INSERT INTO platform.operator_role_changes (operator_id, old_role, new_role, changed_by) VALUES ($1,$2,$3,$4)',
        [id, current.role, role, by.id]);
      return { id, role };
    });
  }

  async revoke(id: string, by: Operator) {
    if (!hasOperatorPermission(by, 'operators:manage')) throw new ApiError(403, 'insufficient_role', 'No tienes permiso para revocar operadores');
    if (id === by.id) throw new ApiError(409, 'cannot_revoke_self', 'No puedes revocarte a ti mismo');
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ role: OperatorRole; revoked_at: Date | null }>(
        'SELECT role, revoked_at FROM platform.operators WHERE id = $1 FOR UPDATE', [id]);
      const current = rows[0];
      if (!current || current.revoked_at) throw new ApiError(404, 'resource_missing', `No existe el operador activo ${id}`);
      if (current.role === 'master') {
        const masters = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM platform.operators WHERE role = 'master' AND revoked_at IS NULL`);
        if (masters.rows[0].n <= 1) throw new ApiError(409, 'last_master', 'Debe quedar al menos un maestro activo');
      }
      await client.query('UPDATE platform.operators SET revoked_at = now() WHERE id = $1', [id]);
      return { id, revoked: true };
    });
  }

  async list() {
    const { rows } = await this.pool.query(
      `SELECT o.id, o.name, o.role, o.created_at, o.revoked_at,
              COALESCE((SELECT json_agg(json_build_object('old_role', rc.old_role, 'new_role', rc.new_role, 'created_at', rc.created_at) ORDER BY rc.created_at DESC)
                         FROM platform.operator_role_changes rc WHERE rc.operator_id = o.id), '[]'::json) AS role_history
         FROM platform.operators o
        ORDER BY o.revoked_at NULLS FIRST, o.name`);
    return rows;
  }
}
