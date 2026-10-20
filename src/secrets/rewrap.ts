import { Pool } from 'pg';
import { SecretVault } from './vault';

/**
 * Dónde hay secretos cifrados y con qué propósito se cifró cada uno. Un secreto
 * nuevo que se guarde en la base se agrega aquí para que la rotación lo cubra.
 */
const SEALED_COLUMNS: Array<{ table: string; key: string[]; column: string; purpose: (row: Record<string, string>) => string }> = [
  { table: 'webhooks.endpoints', key: ['id'], column: 'secret', purpose: () => 'webhook_secret' },
  { table: 'merchants.merchants', key: ['id'], column: 'webhook_secret', purpose: () => 'webhook_secret' },
  { table: 'security.mfa_factors', key: ['principal_type', 'principal_id'], column: 'secret_sealed', purpose: (r) => `mfa:${r.principal_type}:${r.principal_id}` },
  { table: 'platform.rail_credentials', key: ['id'], column: 'sealed', purpose: (r) => `rail:${r.rail}:${r.name}` },
];

/**
 * Vuelve a cifrar con la llave activa todo lo que esté con una llave vieja, en el
 * formato anterior (`enc:v1:`) o en claro. Se corre después de rotar la llave
 * local o de pasar de la llave local a AWS KMS. Idempotente: lo vigente no se toca.
 */
export async function rewrapAll(pool: Pool, v: SecretVault, opts: { dryRun?: boolean } = {}) {
  const report: Record<string, number> = {};
  for (const t of SEALED_COLUMNS) {
    const extra = t.table === 'platform.rail_credentials' ? ', rail, name' : '';
    const { rows } = await pool.query<Record<string, string>>(
      `SELECT ${t.key.join(', ')}, ${t.column} AS value${extra} FROM ${t.table} WHERE ${t.column} IS NOT NULL`);
    let changed = 0;
    for (const row of rows) {
      if (v.isCurrent(row.value)) continue;
      const purpose = t.purpose(row);
      const fresh = await v.seal(await v.open(row.value, purpose), purpose);
      if (!opts.dryRun) {
        const where = t.key.map((k, i) => `${k} = $${i + 3}`).join(' AND ');
        await pool.query(`UPDATE ${t.table} SET ${t.column} = $1 WHERE ${t.column} = $2 AND ${where}`, [fresh, row.value, ...t.key.map((k) => row[k])]);
      }
      changed++;
    }
    report[`${t.table}.${t.column}`] = changed;
  }
  return report;
}
