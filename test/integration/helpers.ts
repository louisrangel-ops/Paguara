import { Pool } from 'pg';
import { createPool } from '../../src/database/database';
import { migrate } from '../../scripts/migrate';
import { FxService } from '../../src/fx/fx.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { PaymentIntentRepository } from '../../src/payment-intents/payment-intent.repository';
import { PaymentIntentsService } from '../../src/payment-intents/payment-intents.service';
import { PAYMENT_METHODS } from '../../src/payment-intents/payment-methods';
import { RailAdapter } from '../../src/payment-intents/rails/rail-adapter';
import { SandboxRail } from '../../src/payment-intents/rails/sandbox.rail';
import { SettlementsService } from '../../src/settlements/settlements.service';
import { MerchantsService } from '../../src/merchants/merchants.service';

/**
 * Cada corrida usa una base nueva (DATABASE_URL apunta a un servidor; se crea
 * pasarela_it_<pid> y se borra al final), porque el ledger es append-only y no
 * se puede truncar entre pruebas.
 */
export async function setup() {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('Define DATABASE_URL (p. ej. postgres://postgres@localhost:5432/postgres)');
  const dbName = `pasarela_it_${process.pid}`;
  const admin = createPool(adminUrl);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  await migrate(url.toString());

  const pool = createPool(url.toString());
  const rails = new Map<string, RailAdapter>();
  for (const { rail } of Object.values(PAYMENT_METHODS)) rails.set(rail, new SandboxRail(rail));
  const ledger = new LedgerService(pool);
  const fx = new FxService(pool);
  const repo = new PaymentIntentRepository();
  const payments = new PaymentIntentsService(pool, repo, ledger, fx, rails);
  const settlements = new SettlementsService(pool, repo, ledger, fx);
  const merchants = new MerchantsService(pool);
  let rifSeq = 0;
  /** Crea un comercio de prueba con el id dado (los códigos de cuenta usan ese id). */
  async function merchant(id: string, status: 'pending_kyc' | 'active' = 'active') {
    rifSeq++;
    await merchants.create({ id, businessName: `Comercio ${id}`, rif: `J-${String(rifSeq).padStart(8, '0')}-${rifSeq % 10}` });
    if (status === 'active') await merchants.setStatus(id, 'active');
    return id;
  }

  async function teardown() {
    await pool.end();
    // Espera a que el servidor cierre las sesiones del pool antes de borrar la base
    for (let i = 0; i < 50; i++) {
      const { rows } = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [dbName]);
      if (rows[0].n === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
  return { pool, ledger, fx, payments, settlements, merchants, merchant, rails, teardown };
}

export async function seedRates(fx: FxService) {
  await fx.recordRate('USD', 'VES', '36.5', 'BCV');
  await fx.recordRate('USDT', 'VES', '38.2', 'BINANCE_P2P');
  await fx.recordRate('USDT', 'USD', '0.999', 'EXCHANGE'); // 1 USDT = 0,999 USD en el exchange
}

export async function pgError(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error('Se esperaba un error');
}

export type Ctx = Awaited<ReturnType<typeof setup>>;
export { Pool };
