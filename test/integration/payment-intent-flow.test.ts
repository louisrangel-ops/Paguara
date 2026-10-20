import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedStatusChanges } from '../../src/payment-intents/payment-intent.state-machine';
import { Ctx, pgError, seedRates, setup } from './helpers';

let ctx: Ctx;
before(async () => {
  ctx = await setup();
  await seedRates(ctx.fx);
  for (let i = 1; i <= 10; i++) await ctx.merchant(`m_${i}`);
});
after(async () => { await ctx.teardown(); });

test('la tabla de transiciones en SQL es idéntica a la máquina de estados en TS', async () => {
  const { rows } = await ctx.pool.query<{ f: string; t: string }>(
    'SELECT from_status::text AS f, to_status::text AS t FROM payments.allowed_transitions ORDER BY 1, 2');
  const sql = rows.map((r) => `${r.f}>${r.t}`).sort();
  const ts = allowedStatusChanges().map(([f, t]) => `${f}>${t}`).sort();
  assert.deepEqual(sql, ts);
});

test('flujo completo: precio en USD, cobro por Pago Móvil en VES a tasa BCV congelada, liquidación en bolívares retenida hasta aprobarla', async () => {
  const { payments, settlements, ledger, pool } = ctx;

  let pi = await payments.create('m_1', { amount: 10000n, currency: 'USD' }); // 100,00 USD
  assert.equal(pi.status, 'requires_payment_method');

  pi = await payments.attachPaymentMethod('m_1', pi.id, 'pago_movil_c2p');
  assert.equal(pi.status, 'requires_confirmation');
  assert.equal(pi.charge_currency, 'VES');
  assert.equal(pi.charge_amount, 365000n);   // 3.650,00 Bs
  assert.equal(pi.fx_rate, '36.5');
  assert.equal(pi.fx_rate_source, 'BCV');
  assert.equal(pi.fee_amount, 5657n);        // 1,5 % + 0,05 USD a 36,5
  assert.equal(pi.tax_amount, 905n);         // IVA 16 % de la comisión
  assert.equal(pi.net_amount, 358438n);

  // Una tasa BCV futura no sustituye la tasa oficial vigente del día ya congelada.
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  await ctx.fx.recordRate('USD', 'VES', '40', 'BCV', new Date(), tomorrow.toISOString().slice(0, 10));
  pi = await payments.confirm('m_1', pi.id, { phone: '04141234567', bank: '0102', otp: '123456' });
  assert.equal(pi.status, 'succeeded');
  assert.equal(pi.charge_amount, 365000n);
  assert.equal(pi.fx_rate, '36.5');
  assert.ok(pi.capture_entry_id);

  assert.equal(await ledger.balance('platform:rail_clearing:ves_c2p:VES'), 365000n);
  assert.equal(await ledger.balance('merchant:m_1:pending:VES'), 358438n);
  assert.equal(await ledger.balance('platform:fee_revenue:VES'), 5657n);
  assert.equal(await ledger.balance('platform:tax_payable:iva:VES'), 905n);

  // Monto y tasa ya no se pueden tocar, ni siquiera con SQL directo
  const frozen = await pgError(pool.query(`UPDATE payments.payment_intents SET fx_rate = 40, charge_amount = 400000 WHERE id = $1`, [pi.id]));
  assert.equal(frozen.code, 'P0012');

  // Por ley se liquida en bolívares: una sola cuenta en Bs al 100 %
  await assert.rejects(ctx.merchants.setSettlementRules('m_1', 'VES', [
    { targetCurrency: 'VES', bps: 6000, destination: { bank: '0102', account: '01020000000000000000', rif: 'J-00000001-1' } },
    { targetCurrency: 'USDT', bps: 4000, destination: { network: 'TRON', address: 'TXYZ...' } },
  ]), /solo en bolívares/);
  const usdtRule = await pgError(pool.query(
    `INSERT INTO merchants.settlement_rules (merchant_id, source_currency, target_currency, bps, destination) VALUES ('m_1', 'VES', 'USDT', 10000, '{}')`));
  assert.equal(usdtRule.code, '23514');                       // la base tampoco lo acepta
  await ctx.merchants.setSettlementRules('m_1', 'VES', [
    { targetCurrency: 'VES', bps: 10000, destination: { bank: '0102', account: '01020000000000000000', rif: 'J-00000001-1' } },
  ]);

  // Un corte antes de que el banco acredite no liquida nada
  const early = await settlements.runCutoff('2026-10-16-VES-1200', { sourceCurrency: 'VES' });
  assert.equal(early.payouts.length, 0);

  await settlements.recordRailFunds('cierre_2026_10_16', 'ves_c2p', 'VES', [pi.id]);
  assert.equal(await ledger.balance('platform:cash:VES'), 365000n);
  assert.equal(await ledger.balance('merchant:m_1:pending:VES'), 0n);
  assert.equal(await ledger.balance('merchant:m_1:available:VES'), 358438n);

  const cut = await settlements.runCutoff('2026-10-16-VES-1800', { sourceCurrency: 'VES', spreadBps: 120 });
  assert.equal(cut.payouts.length, 1);
  assert.deepEqual(cut.payouts[0].legs.map((l) => [l.currency, l.amount, l.spread]), [['VES', 358438n, 0n]]); // sin conversión: sin spread
  assert.equal(await ledger.balance('merchant:m_1:available:VES'), 0n);
  assert.equal(await ledger.balance('platform:cash:VES'), 365000n - 358438n);

  const instr = await pool.query<{ currency: string; amount: bigint; status: string }>(
    `SELECT currency, amount, status FROM settlements.payout_instructions WHERE payout_id = $1 ORDER BY currency`, [cut.payouts[0].payoutId]);
  assert.deepEqual(instr.rows.map((r) => [r.currency, r.amount, r.status]), [['VES', 358438n, 'on_hold']]); // retenida hasta aprobarla

  // Repetir el mismo corte no liquida dos veces
  const again = await settlements.runCutoff('2026-10-16-VES-1800', { sourceCurrency: 'VES' });
  assert.equal(again.payouts.length, 0);

  pi = (await payments.retrieve('m_1', pi.id));
  assert.equal(pi.status, 'settled');

  const { rows } = await pool.query<{ e: string }>(
    `SELECT from_status::text || '>' || to_status::text || ':' || event AS e FROM payments.payment_intent_transitions
      WHERE payment_intent_id = $1 ORDER BY id`, [pi.id]);
  assert.deepEqual(rows.map((r) => r.e), [
    null, // create: from_status NULL
    'requires_payment_method>requires_confirmation:attach_payment_method',
    'requires_confirmation>processing:confirm',
    'processing>succeeded:rail_succeeded',
    'succeeded>settled:settle',
  ]);

  assert.equal((await pool.query('SELECT * FROM ledger.trial_balance WHERE total <> 0')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM ledger.balance_drift')).rowCount, 0);
});

test('Pago Móvil P2P: requires_action con instrucciones; el matcher confirma después', async () => {
  let pi = await ctx.payments.create('m_2', { amount: 2500n, currency: 'USD' });
  pi = await ctx.payments.attachPaymentMethod('m_2', pi.id, 'pago_movil_p2p');
  pi = await ctx.payments.confirm('m_2', pi.id, {});
  assert.equal(pi.status, 'requires_action');
  assert.equal(pi.next_action?.type, 'pago_movil_transfer');
  assert.equal(pi.next_action?.amount, '91250'); // 25 USD × 36,5 (BCV vigente del día) = 912,50 Bs

  // La tasa sigue congelada mientras se espera la transferencia
  assert.equal((await pgError(ctx.pool.query('UPDATE payments.payment_intents SET charge_amount = 1 WHERE id = $1', [pi.id]))).code, 'P0012');

  pi = await ctx.payments.applyRailResult(pi.id, { status: 'succeeded', reference: 'p2p_ref_778812' }, 'worker:p2p_matcher');
  assert.equal(pi.status, 'succeeded');
  // Webhook duplicado: no duplica el asiento
  pi = await ctx.payments.applyRailResult(pi.id, { status: 'succeeded', reference: 'p2p_ref_778812' }, 'worker:p2p_matcher');
  const entries = await ctx.pool.query(`SELECT 1 FROM ledger.journal_entries WHERE reference_id = $1`, [pi.id]);
  assert.equal(entries.rowCount, 1);
});

test('rechazo del banco: vuelve a requires_payment_method sin tocar el ledger y permite reintentar', async () => {
  let pi = await ctx.payments.create('m_3', { amount: 50000n, currency: 'VES' });
  pi = await ctx.payments.attachPaymentMethod('m_3', pi.id, 'pago_movil_c2p');
  pi = await ctx.payments.confirm('m_3', pi.id, { phone: '04140000002' });
  assert.equal(pi.status, 'requires_payment_method');
  assert.equal(pi.last_payment_error?.code, 'insufficient_funds');
  assert.equal(pi.capture_entry_id, null);
  assert.equal((await ctx.pool.query('SELECT 1 FROM ledger.journal_entries WHERE reference_id = $1', [pi.id])).rowCount, 0);

  pi = await ctx.payments.attachPaymentMethod('m_3', pi.id, 'pago_movil_c2p');
  pi = await ctx.payments.confirm('m_3', pi.id, { phone: '04141112233' });
  assert.equal(pi.status, 'succeeded');
});

test('cotización vencida: no se confirma con una tasa vieja', async () => {
  let pi = await ctx.payments.create('m_4', { amount: 1000n, currency: 'USD' });
  pi = await ctx.payments.attachPaymentMethod('m_4', pi.id, 'pago_movil_c2p');
  // Simula que pasaron los 5 minutos: se reemplaza la cotización por una ya vencida
  await ctx.pool.query(`UPDATE payments.payment_intents SET fx_quote_expires_at = now() - interval '1 second' WHERE id = $1`, [pi.id]);
  await assert.rejects(ctx.payments.confirm('m_4', pi.id, {}), (e: { code: string }) => e.code === 'fx_quote_expired');
  pi = await ctx.payments.retrieve('m_4', pi.id);
  assert.equal(pi.status, 'requires_confirmation');
});

test('dos confirmaciones simultáneas del mismo intent: un solo cobro', async () => {
  let pi = await ctx.payments.create('m_5', { amount: 1000n, currency: 'USD' });
  pi = await ctx.payments.attachPaymentMethod('m_5', pi.id, 'zelle');
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => ctx.payments.confirm('m_5', pi.id, {})));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'payment_intent_unexpected_state'));
});

test('no se puede cancelar un intent cobrado, ni por la app ni por SQL', async () => {
  let pi = await ctx.payments.create('m_6', { amount: 1000n, currency: 'USD' });
  pi = await ctx.payments.attachPaymentMethod('m_6', pi.id, 'card_international');
  pi = await ctx.payments.confirm('m_6', pi.id, { token: 'tok_visa' });
  assert.equal(pi.status, 'succeeded');
  assert.equal(pi.fx_quote_id, null); // USD→USD: sin conversión
  await assert.rejects(ctx.payments.cancel('m_6', pi.id), /No se puede aplicar "cancel"/);
  const err = await pgError(ctx.pool.query(`UPDATE payments.payment_intents SET status = 'canceled' WHERE id = $1`, [pi.id]));
  assert.equal(err.code, 'P0011');
});

test('USDT: precio en VES, cobro en USDT a tasa Binance P2P', async () => {
  let pi = await ctx.payments.create('m_7', { amount: 382000n, currency: 'VES' }); // 3.820,00 Bs
  pi = await ctx.payments.attachPaymentMethod('m_7', pi.id, 'usdt_trc20');
  assert.equal(pi.charge_currency, 'USDT');
  assert.equal(pi.fx_rate_source, 'BINANCE_P2P');
  assert.equal(pi.charge_amount, 100_000_000n); // 100,000000 USDT
  // Comisión 1,2 % + 0,10 USD, y los 0,10 USD pasan a USDT con la tasa del exchange (0,999)
  assert.equal(pi.fee_amount, 1_200_000n + 100_100n);
  assert.equal(pi.igtf_amount, 0n);
});

test('efectivo en divisas: el pagador paga IGTF 3 % encima y queda como impuesto por pagar', async () => {
  let pi = await ctx.payments.create('m_10', { amount: 5000n, currency: 'USD' }); // 50,00 USD
  pi = await ctx.payments.attachPaymentMethod('m_10', pi.id, 'cash');
  assert.equal(pi.igtf_amount, 150n);
  assert.equal(pi.charge_amount, 5150n);          // 51,50 USD en taquilla
  pi = await ctx.payments.confirm('m_10', pi.id, {});
  assert.equal(pi.status, 'requires_action');
  pi = await ctx.payments.applyRailResult(pi.id, { status: 'succeeded', reference: 'taquilla_001' }, 'worker:cash_network');
  assert.equal(pi.status, 'succeeded');
  assert.equal(await ctx.ledger.balance('platform:tax_payable:igtf:USD'), 150n);
  assert.equal(await ctx.ledger.balance('merchant:m_10:pending:USD'), 5000n - 125n); // 2 % + 0,25 USD
});

test('un comercio no puede ver ni operar intents de otro', async () => {
  const pi = await ctx.payments.create('m_8', { amount: 1000n, currency: 'USD' });
  await assert.rejects(ctx.payments.retrieve('m_9', pi.id), /No existe/);
  await assert.rejects(ctx.payments.attachPaymentMethod('m_9', pi.id, 'zelle'), /No existe/);
});
