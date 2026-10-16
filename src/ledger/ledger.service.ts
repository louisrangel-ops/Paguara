import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database';
import { accountSpec } from './chart-of-accounts';
import { EntryDraft, assertBalanced } from './ledger.types';

export interface PostedEntry {
  entryId: string;
  /** false si la idempotency key ya existía y se devolvió el asiento original. */
  created: boolean;
}

@Injectable()
export class LedgerService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Registra un asiento dentro de la transacción del llamador, para que el
   * cambio de estado del negocio y el asiento sean atómicos.
   * Idempotente por `draft.idempotencyKey`.
   */
  async post(client: PoolClient, draft: EntryDraft): Promise<PostedEntry> {
    assertBalanced(draft.lines);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ledger.journal_entries (idempotency_key, kind, reference_type, reference_id, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [draft.idempotencyKey, draft.kind, draft.referenceType ?? null, draft.referenceId ?? null,
       draft.description ?? null, JSON.stringify(draft.metadata ?? {})],
    );
    if (inserted.rowCount === 0) {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM ledger.journal_entries WHERE idempotency_key = $1', [draft.idempotencyKey]);
      return { entryId: existing.rows[0].id, created: false };
    }
    const entryId = inserted.rows[0].id;

    const ids = await this.resolveAccounts(client, draft.lines.map((l) => l.accountCode));
    // Orden fijo por account_id: dos asientos concurrentes bloquean saldos en el
    // mismo orden y no pueden hacer deadlock entre sí.
    const rows = draft.lines
      .map((l) => ({ ...l, accountId: ids.get(l.accountCode)! }))
      .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));

    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      values.push(entryId, r.accountId, r.currency, r.amount.toString(), r.fxRate ?? null);
      const b = i * 5;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::bigint, $${b + 5}::numeric)`;
    });
    await client.query(
      `INSERT INTO ledger.postings (entry_id, account_id, currency, amount, fx_rate) VALUES ${tuples.join(', ')}`,
      values,
    );
    return { entryId, created: true };
  }

  /** Crea bajo demanda las cuentas del plan que aún no existen y devuelve code → id. */
  async resolveAccounts(client: PoolClient, codes: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(codes)].sort();
    for (const code of unique) {
      const s = accountSpec(code);
      await client.query(
        `INSERT INTO ledger.accounts (code, name, type, currency, owner_type, owner_id, allow_negative)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (code) DO NOTHING`,
        [s.code, s.name, s.type, s.currency, s.ownerType, s.ownerId, s.allowNegative],
      );
    }
    const res = await client.query<{ id: string; code: string }>(
      'SELECT id, code FROM ledger.accounts WHERE code = ANY($1)', [unique]);
    return new Map(res.rows.map((r) => [r.code, r.id]));
  }

  /** Saldo natural: positivo = lo que la cuenta "tiene" según su naturaleza (deudora o acreedora). */
  async balance(code: string, client: Pool | PoolClient = this.pool): Promise<bigint> {
    const res = await client.query<{ balance: bigint; type: string }>(
      `SELECT b.balance, a.type FROM ledger.account_balances b
         JOIN ledger.accounts a ON a.id = b.account_id WHERE a.code = $1`, [code]);
    if (res.rowCount === 0) return 0n;
    const { balance, type } = res.rows[0];
    return type === 'asset' || type === 'expense' ? balance : -balance;
  }
}
