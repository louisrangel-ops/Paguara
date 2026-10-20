import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMerchantCanOperate } from '../../src/common/api-key.guard';
import { withTransaction } from '../../src/database/database';
import { Ctx, pgError, seedRates, setup } from './helpers';

let ctx: Ctx;
before(async () => { ctx = await setup(); await seedRates(ctx.fx); });
after(async () => { await ctx.teardown(); });

test('API keys: solo se guarda el hash; revocar la invalida; formato estricto', async () => {
  const m = await ctx.merchant('acct_keys', 'pending_kyc');
  const sk = await ctx.merchants.createApiKey(m, 'secret', false);
  assert.match(sk.key, /^sk_test_[a-f0-9]{32}$/);
  const stored = await ctx.pool.query('SELECT 1 FROM merchants.api_keys WHERE key_hash = $1 OR key_prefix = $1', [sk.key]);
  assert.equal(stored.rowCount, 0); // la llave en claro no está en la BD

  const auth = await ctx.merchants.authenticate(sk.key);
  assert.deepEqual(auth, { merchantId: m, merchantStatus: 'pending_kyc', kind: 'secret', livemode: false });
  // Cambia el último carácter por uno distinto (si la llave ya terminaba en '0', la "falsa" era la misma).
  const tampered = sk.key.slice(0, -1) + (sk.key.endsWith('0') ? '1' : '0');
  assert.equal(await ctx.merchants.authenticate(tampered), null);
  assert.equal(await ctx.merchants.authenticate("sk_test_' OR 1=1 --"), null);

  await ctx.merchants.revokeApiKey(m, sk.id);
  assert.equal(await ctx.merchants.authenticate(sk.key), null);
});

test('KYC: llaves de prueba sí, llaves live solo con comercio activo', () => {
  assert.doesNotThrow(() => assertMerchantCanOperate('pending_kyc', false));
  assert.throws(() => assertMerchantCanOperate('pending_kyc', true), /KYC/);
  assert.doesNotThrow(() => assertMerchantCanOperate('active', true));
  assert.throws(() => assertMerchantCanOperate('restricted', false), /no puede operar/);
});

test('el RIF se valida y es único', async () => {
  await assert.rejects(ctx.merchants.create({ businessName: 'X', rif: '123' }));
  await ctx.merchants.create({ businessName: 'A', rif: 'J-12345678-9' });
  await assert.rejects(ctx.merchants.create({ businessName: 'B', rif: 'j-12345678-9' }));
});

test('checkout: client_secret correcto y del mismo comercio; si no, "no existe"', async () => {
  const m = await ctx.merchant('acct_shop');
  const other = await ctx.merchant('acct_other');
  const pi = await ctx.payments.create(m, { amount: 1000n, currency: 'USD' });
  assert.match(pi.client_secret, new RegExp(`^${pi.id}_secret_[a-f0-9]{32}$`));
  assert.equal((await ctx.payments.authorizeCheckout(m, pi.id, pi.client_secret)).id, pi.id);
  await assert.rejects(ctx.payments.authorizeCheckout(m, pi.id, pi.client_secret.slice(0, -1) + 'x'), /No existe/);
  await assert.rejects(ctx.payments.authorizeCheckout(other, pi.id, pi.client_secret), /No existe/);
  await assert.rejects(ctx.payments.authorizeCheckout(m, pi.id, ''), /No existe/);
});

test('idempotencia durable en BD: misma llave devuelve el mismo intent aunque Redis no esté', async () => {
  const m = await ctx.merchant('acct_idem');
  const a = await ctx.payments.create(m, { amount: 1000n, currency: 'USD', idempotencyKey: 'orden-77' });
  const b = await ctx.payments.create(m, { amount: 1000n, currency: 'USD', idempotencyKey: 'orden-77' });
  assert.equal(a.id, b.id);
  await assert.rejects(ctx.payments.create(m, { amount: 2000n, currency: 'USD', idempotencyKey: 'orden-77' }),
    (e: { code: string }) => e.code === 'idempotency_key_reused');
  const concurrent = await Promise.all([1, 2, 3, 4, 5].map(() =>
    ctx.payments.create(m, { amount: 500n, currency: 'VES', idempotencyKey: 'orden-78' })));
  assert.equal(new Set(concurrent.map((p) => p.id)).size, 1);
});

test('vencimiento: un link abandonado se cancela; uno que espera transferencia no', async () => {
  const m = await ctx.merchant('acct_exp');
  const idle = await ctx.payments.create(m, { amount: 1000n, currency: 'USD', expiresInSeconds: 60 });
  let waiting = await ctx.payments.create(m, { amount: 1000n, currency: 'USD', expiresInSeconds: 60 });
  waiting = await ctx.payments.attachPaymentMethod(m, waiting.id, 'zelle');
  waiting = await ctx.payments.confirm(m, waiting.id, {});
  assert.equal(waiting.status, 'requires_action');
  await ctx.pool.query(`UPDATE payments.payment_intents SET expires_at = now() - interval '1 second' WHERE id = ANY($1)`, [[idle.id, waiting.id]]);

  await assert.rejects(ctx.payments.attachPaymentMethod(m, idle.id, 'zelle'), (e: { code: string }) => e.code === 'payment_intent_expired');
  assert.ok((await ctx.payments.expireStale()) >= 1);
  assert.equal((await ctx.payments.retrieve(m, idle.id)).status, 'canceled');
  assert.equal((await ctx.payments.retrieve(m, idle.id)).cancellation_reason, 'expired');
  assert.equal((await ctx.payments.retrieve(m, waiting.id)).status, 'requires_action');
});

test('los saldos no se editan a mano y cada partida guarda el saldo resultante', async () => {
  await withTransaction(ctx.pool, (c) => ctx.ledger.post(c, {
    idempotencyKey: 'cap:1', kind: 'capital_contribution',
    lines: [
      { accountCode: 'platform:cash:USD', currency: 'USD', amount: 5000n },
      { accountCode: 'platform:fx_position:USD', currency: 'USD', amount: -5000n },
    ],
  }));
  await withTransaction(ctx.pool, (c) => ctx.ledger.post(c, {
    idempotencyKey: 'cap:2', kind: 'capital_contribution',
    lines: [
      { accountCode: 'platform:cash:USD', currency: 'USD', amount: 700n },
      { accountCode: 'platform:fx_position:USD', currency: 'USD', amount: -700n },
    ],
  }));
  const { rows } = await ctx.pool.query<{ balance_after: bigint }>(
    `SELECT p.balance_after FROM ledger.postings p JOIN ledger.accounts a ON a.id = p.account_id
      WHERE a.code = 'platform:cash:USD' ORDER BY p.id`);
  assert.deepEqual(rows.map((r) => r.balance_after), [5000n, 5700n]);

  for (const sql of [
    `UPDATE ledger.account_balances SET balance = 999999`,
    `DELETE FROM ledger.account_balances`,
    `TRUNCATE ledger.account_balances CASCADE`,
  ]) assert.equal((await pgError(ctx.pool.query(sql))).code, 'P0005', sql);
});

test('corte de lote: sin regla de split o bajo el mínimo, el comercio espera al próximo corte', async () => {
  const noRule = await ctx.merchant('acct_norule');
  const small = await ctx.merchant('acct_small');
  await assert.rejects(ctx.merchants.setSettlementRules(small, 'USD', [{ targetCurrency: 'USD', bps: 10000, destination: { bank: 'Banesco Panamá' } }]), /solo en bolívares/);
  await assert.rejects(ctx.merchants.setSettlementRules(small, 'USD', [{ targetCurrency: 'VES', bps: 9000, destination: {} }]), /100 %/);
  await ctx.merchants.setSettlementRules(small, 'USD', [{ targetCurrency: 'VES', bps: 10000, destination: { bank: '0134', account: '01340000000000001234' } }]);

  const ids: string[] = [];
  for (const m of [noRule, small]) {
    let pi = await ctx.payments.create(m, { amount: 1000n, currency: 'USD' });
    pi = await ctx.payments.attachPaymentMethod(m, pi.id, 'card_international');
    pi = await ctx.payments.confirm(m, pi.id, { token: 'tok_visa' });
    ids.push(pi.id);
  }
  await ctx.settlements.recordRailFunds('offshore_1', 'offshore_card', 'USD', ids);
  const r = await ctx.settlements.runCutoff('2026-10-16-USD', { sourceCurrency: 'USD', minAmount: 5000n });
  assert.equal(r.payouts.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['below_minimum', 'below_minimum']);
  // Pagar en bolívares lo cobrado en dólares exige bolívares en la tesorería
  await withTransaction(ctx.pool, (c) => ctx.ledger.post(c, {
    idempotencyKey: 'treasury:ves:usd-cut', kind: 'capital_contribution', description: 'Aporte de capital en VES (prueba)',
    lines: [
      { accountCode: 'platform:cash:VES', currency: 'VES', amount: 10_000_000n },
      { accountCode: 'platform:fx_position:VES', currency: 'VES', amount: -10_000_000n },
    ],
  }));
  const r2 = await ctx.settlements.runCutoff('2026-10-17-USD', { sourceCurrency: 'USD' });
  assert.deepEqual(r2.payouts.map((p) => p.merchantId), [small]);
  // Lo cobrado en dólares se le paga en bolívares a tasa BCV, menos el spread de conversión
  const [leg] = r2.payouts[0].legs;
  assert.equal(leg.currency, 'VES');
  assert.equal(leg.rate, '36.5');
  assert.ok(leg.spread > 0n);
  assert.deepEqual(r2.skipped, [{ merchantId: noRule, reason: 'no_settlement_rule' }]);
});
