import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTransaction } from '../../src/database/database';
import { Ctx, pgError, setup } from './helpers';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });

async function rawEntry(lines: Array<[string, string, bigint]>, key = `raw:${Math.random()}`) {
  return withTransaction(ctx.pool, async (c) => {
    const ids = await ctx.ledger.resolveAccounts(c, lines.map((l) => l[0]));
    const e = await c.query<{ id: string }>(
      `INSERT INTO ledger.journal_entries (idempotency_key, kind) VALUES ($1, 'fee_adjustment') RETURNING id`, [key]);
    for (const [code, cur, amount] of lines) {
      await c.query('INSERT INTO ledger.postings (entry_id, account_id, currency, amount) VALUES ($1, $2, $3, $4)',
        [e.rows[0].id, ids.get(code), cur, amount.toString()]);
    }
    return e.rows[0].id;
  });
}

test('la BD rechaza un asiento descuadrado aunque la app no lo valide', async () => {
  const err = await pgError(rawEntry([
    ['platform:fx_position:VES', 'VES', 100n],
    ['platform:fx_position:USD', 'USD', -100n], // cuadra en "número" pero no por moneda
  ]));
  assert.equal(err.code, 'P0004');
});

test('la BD rechaza un asiento con una sola partida o vacío', async () => {
  assert.equal((await pgError(rawEntry([['platform:fx_position:VES', 'VES', 100n]]))).code, 'P0004');
  assert.equal((await pgError(rawEntry([]))).code, 'P0004');
});

test('la BD rechaza una partida en moneda distinta a la de su cuenta', async () => {
  const err = await pgError(withTransaction(ctx.pool, async (c) => {
    const ids = await ctx.ledger.resolveAccounts(c, ['platform:cash:VES']);
    const e = await c.query<{ id: string }>(`INSERT INTO ledger.journal_entries (idempotency_key, kind) VALUES ('x1', 'fee_adjustment') RETURNING id`);
    await c.query(`INSERT INTO ledger.postings (entry_id, account_id, currency, amount) VALUES ($1, $2, 'USD', 1)`,
      [e.rows[0].id, ids.get('platform:cash:VES')]);
  }));
  assert.equal(err.code, 'P0002');
});

test('ningún saldo de comercio puede quedar negativo', async () => {
  const err = await pgError(rawEntry([
    ['merchant:m_x:available:VES', 'VES', 500n], // débito a un pasivo sin saldo = pagarle de más
    ['platform:fx_position:VES', 'VES', -500n],
  ]));
  assert.equal(err.code, 'P0003');
});

test('postings y asientos son append-only', async () => {
  const id = await rawEntry([
    ['platform:fx_position:EUR', 'EUR', 100n],
    ['platform:fee_revenue:EUR', 'EUR', -100n],
  ]);
  for (const sql of [
    `UPDATE ledger.postings SET amount = 999 WHERE entry_id = '${id}'`,
    `DELETE FROM ledger.postings WHERE entry_id = '${id}'`,
    `UPDATE ledger.journal_entries SET description = 'x' WHERE id = '${id}'`,
    `DELETE FROM ledger.journal_entries WHERE id = '${id}'`,
    `TRUNCATE ledger.postings CASCADE`,
  ]) {
    assert.equal((await pgError(ctx.pool.query(sql))).code, 'P0005', sql);
  }
});

test('LedgerService.post es idempotente por llave', async () => {
  const draft = {
    idempotencyKey: 'adj:1', kind: 'fee_adjustment' as const,
    lines: [
      { accountCode: 'platform:fx_position:USD', currency: 'USD' as const, amount: 250n },
      { accountCode: 'platform:fee_revenue:USD', currency: 'USD' as const, amount: -250n },
    ],
  };
  const a = await withTransaction(ctx.pool, (c) => ctx.ledger.post(c, draft));
  const b = await withTransaction(ctx.pool, (c) => ctx.ledger.post(c, draft));
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.entryId, b.entryId);
  assert.equal(await ctx.ledger.balance('platform:fee_revenue:USD'), 250n);
});

test('100 asientos concurrentes sobre las mismas cuentas: sin deadlocks ni saldos desviados', async () => {
  await Promise.all(Array.from({ length: 100 }, (_, i) => withTransaction(ctx.pool, (c) => ctx.ledger.post(c, {
    idempotencyKey: `conc:${i}`, kind: 'fee_adjustment',
    lines: i % 2
      ? [{ accountCode: 'platform:fx_position:VES', currency: 'VES', amount: 7n }, { accountCode: 'platform:fee_revenue:VES', currency: 'VES', amount: -7n }]
      : [{ accountCode: 'platform:fee_revenue:VES', currency: 'VES', amount: -7n }, { accountCode: 'platform:fx_position:VES', currency: 'VES', amount: 7n }],
  }))));
  assert.equal(await ctx.ledger.balance('platform:fee_revenue:VES'), 700n);
  const drift = await ctx.pool.query('SELECT * FROM ledger.balance_drift');
  assert.equal(drift.rowCount, 0);
  const tb = await ctx.pool.query<{ total: bigint }>('SELECT total FROM ledger.trial_balance WHERE total <> 0');
  assert.equal(tb.rowCount, 0);
});
