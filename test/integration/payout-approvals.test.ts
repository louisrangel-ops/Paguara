import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { OperatorsService } from '../../src/settlements/operators.service';
import { Ctx, pgError, seedRates, setup } from './helpers';

let ctx: Ctx;
let ops: OperatorsService;
before(async () => { ctx = await setup(); await seedRates(ctx.fx); ops = new OperatorsService(ctx.pool); });
after(async () => { await ctx.teardown(); });

const code = (c: string) => (e: { code: string }) => e.code === c;

/** Un comercio con un cobro conciliado y su cuenta en bolívares, listo para el corte. */
async function settleable(id: string) {
  const m = await ctx.merchant(id);
  await ctx.merchants.setSettlementRules(m, 'VES', [{ targetCurrency: 'VES', bps: 10000, destination: { bank: '0102', account: '01020000000000000001' } }]);
  let pi = await ctx.payments.create(m, { amount: 2000n, currency: 'USD' });
  pi = await ctx.payments.attachPaymentMethod(m, pi.id, 'pago_movil_c2p');
  pi = await ctx.payments.confirm(m, pi.id, { phone: '04141234567', bank: '0102', otp: '1' });
  await ctx.settlements.recordRailFunds(`cierre_${id}`, 'ves_c2p', 'VES', [pi.id]);
  return m;
}

test('operadores: el token de sistema crea solo al primer maestro; después los crea un maestro', async () => {
  await assert.rejects(ops.create({ name: 'Ana', role: 'operator' }, 'system'), code('insufficient_role'));
  const ana = await ops.create({ name: 'Ana', role: 'master' }, 'system');
  assert.match(ana.token, /^opk_[a-f0-9]{48}$/);
  await assert.rejects(ops.create({ name: 'Otro', role: 'master' }, 'system'), code('insufficient_role'));

  const anaOp = (await ops.authenticate(ana.token))!;
  assert.deepEqual(anaOp, { id: ana.id, name: 'Ana', role: 'master' });
  const beto = await ops.create({ name: 'Beto', role: 'operator' }, anaOp);
  const betoOp = (await ops.authenticate(beto.token))!;
  await assert.rejects(ops.create({ name: 'Carla', role: 'operator' }, betoOp), code('insufficient_role'));
  await assert.rejects(ops.create({ name: 'Beto', role: 'operator' }, anaOp), code('name_taken'));

  const stored = await ctx.pool.query('SELECT 1 FROM platform.operators WHERE token_hash = $1', [beto.token]);
  assert.equal(stored.rowCount, 0); // el token en claro no está en la base
  await ops.revoke(beto.id, anaOp);
  assert.equal(await ops.authenticate(beto.token), null);
  await assert.rejects(ops.revoke(ana.id, anaOp), code('cannot_revoke_self'));
});

test('liquidación: nace retenida y solo se libera con dos personas distintas', async () => {
  const m = await settleable('acct_po_two');
  // Ana, la maestra de la prueba anterior, da de alta a dos operadores
  const { rows: [ana] } = await ctx.pool.query<{ id: string }>(`SELECT id FROM platform.operators WHERE name = 'Ana'`);
  const master = { id: ana.id, name: 'Ana', role: 'master' as const };
  const o1 = (await ops.authenticate((await ops.create({ name: 'Uno', role: 'operator' }, master)).token))!;
  const o2 = (await ops.authenticate((await ops.create({ name: 'Dos', role: 'operator' }, master)).token))!;

  const cut = await ctx.settlements.runCutoff('2026-10-20-VES-aprob', { sourceCurrency: 'VES' });
  const payout = cut.payouts.find((p) => p.merchantId === m)!;
  const status = async () => (await ctx.pool.query<{ status: string }>(
    'SELECT status FROM settlements.payout_instructions WHERE payout_id = $1', [payout.payoutId])).rows.map((r) => r.status);

  assert.deepEqual(await status(), ['on_hold']);
  assert.ok((await ctx.settlements.pendingApprovals()).some((p) => p.id === payout.payoutId));

  // Tesorería no puede liberarla a mano, ni con SQL directo
  assert.equal((await pgError(ctx.pool.query(`UPDATE settlements.payout_instructions SET status = 'pending' WHERE payout_id = $1`, [payout.payoutId]))).code, 'P0020');
  assert.equal((await pgError(ctx.pool.query(`UPDATE settlements.payouts SET status = 'approved' WHERE id = $1`, [payout.payoutId]))).code, 'P0020');
  assert.equal((await pgError(ctx.pool.query(`UPDATE settlements.payouts SET approvals_required = 1 WHERE id = $1`, [payout.payoutId]))).code, 'P0020');

  const first = await ctx.settlements.approvePayout(payout.payoutId, o1);
  assert.deepEqual(first, { id: payout.payoutId, status: 'pending_approval', approvals: 1, approvals_required: 2 });
  await assert.rejects(ctx.settlements.approvePayout(payout.payoutId, o1), code('already_approved_by_you'));
  assert.deepEqual(await status(), ['on_hold']);

  const second = await ctx.settlements.approvePayout(payout.payoutId, o2);
  assert.equal(second.status, 'approved');
  assert.deepEqual(await status(), ['pending']);
  await assert.rejects(ctx.settlements.approvePayout(payout.payoutId, o1), code('payout_already_approved'));
  assert.ok(!(await ctx.settlements.pendingApprovals()).some((p) => p.id === payout.payoutId));

  // La aprobación es append-only y una instrucción liberada no vuelve a retenerse
  assert.equal((await pgError(ctx.pool.query('DELETE FROM settlements.payout_approvals WHERE payout_id = $1', [payout.payoutId]))).code, 'P0005');
  assert.equal((await pgError(ctx.pool.query(`UPDATE settlements.payout_instructions SET status = 'on_hold' WHERE payout_id = $1`, [payout.payoutId]))).code, 'P0020');
});

test('liquidación: no se puede pagar en otra moneda que bolívares', async () => {
  const { rows } = await ctx.pool.query<{ id: string }>('SELECT id FROM settlements.payouts LIMIT 1');
  const e = await pgError(ctx.pool.query(
    `INSERT INTO settlements.payout_instructions (payout_id, currency, amount, destination) VALUES ($1, 'USDT', 1, '{}')`, [rows[0].id]));
  assert.equal(e.code, '23514');
});
