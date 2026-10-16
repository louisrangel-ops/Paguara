import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool } from '../src/database/database';

/** Aplica db/migrations/*.sql en orden, una sola vez cada una. */
export async function migrate(databaseUrl = process.env.DATABASE_URL): Promise<string[]> {
  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('SELECT pg_advisory_lock(726354)');
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM public.schema_migrations')).rows.map((r) => r.name));
    const dir = join(__dirname, '..', 'db', 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migración ${file} falló: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(726354)').catch(() => undefined);
    client.release();
    await pool.end();
  }
  return applied;
}

if (require.main === module) {
  migrate().then((a) => console.log(a.length ? `Aplicadas: ${a.join(', ')}` : 'Sin migraciones pendientes'),
    (e) => { console.error(e.message); process.exit(1); });
}
