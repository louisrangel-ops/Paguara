import { Pool, PoolClient, types } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

// BIGINT (int8) llega como bigint, nunca como number: no se pierde precisión.
types.setTypeParser(20, (v) => BigInt(v));

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL no está definido');
  const pool = new Pool({ connectionString, max: Number(process.env.PG_POOL_MAX ?? 20) });
  // Un cliente inactivo que pierde la conexión emite 'error'; sin este handler tumbaría el proceso.
  pool.on('error', (err) => console.error(`[pg] conexión inactiva perdida: ${err.message}`));
  return pool;
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/**
 * Ejecuta `fn` en una transacción. Reintenta ante fallos de serialización o
 * deadlock, que en un ledger con locks de fila son esperables y seguros de
 * repetir porque todo el trabajo se deshizo.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  { isolation = 'READ COMMITTED', retries = 3 }: { isolation?: 'READ COMMITTED' | 'SERIALIZABLE'; retries?: number } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.random() * 10));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
