import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilitiesService } from '../../src/capabilities/capabilities.service';
import { allowedFor, methodSettings } from '../../src/capabilities/capability-state';
import { DashboardService } from '../../src/dashboard/dashboard.service';
import { WebhooksService } from '../../src/webhooks/webhooks.service';
import { withTransaction } from '../../src/database/database';
import { Ctx, pgError, seedRates, setup } from './helpers';

let ctx: Ctx;
let caps: CapabilitiesService;

before(async () => {
  ctx = await setup();
  await seedRates(ctx.fx);
  caps = new CapabilitiesService(ctx.pool);
});
after(async () => { await ctx.teardown(); });

const code = (c: string) => (e: { code: string }) => e.code === c;

test('un comercio nuevo nace con los defaults de plataforma; lo que no es default se pide y queda en revisión', async () => {
  await caps.platformSetGlobal('card_international', { default_for_new: false }, 'platform:test');
  const m = await ctx.merchant('acct_caps_new');
  const list = await caps.list(m);
  const card = list.find((c) => c.key === 'card_international')!;
  assert.equal(card.state, 'not_granted');
  assert.equal(card.can_request, true);
  assert.equal(list.find((c) => c.key === 'pago_movil_c2p')!.state, 'active');
  assert.equal(list.find((c) => c.key === 'payment_links')!.kind, 'module');

  await assert.rejects(caps.setMerchantEnabled(m, 'card_international', true, 'user:x'), code('capability_locked'));
  assert.equal((await caps.request(m, 'card_international', 'user:x')).state, 'pending_review');
  assert.equal((await caps.platformSetForMerchant(m, 'card_international', { platform_status: 'allowed' }, 'platform:kyc')).state, 'active');
  await caps.platformSetGlobal('card_international', { default_for_new: true }, 'platform:test');
});

test('el comercio apaga un método: no se puede crear, elegir ni confirmar con él; lo ya en curso sigue', async () => {
  const m = await ctx.merchant('acct_caps_off');
  const pi = await ctx.payments.create(m, { amount: 1000n, currency: 'USD' });
  const ready = await ctx.payments.attachPaymentMethod(m, pi.id, 'zelle'); // requires_confirmation
  const transfer = await ctx.payments.create(m, { amount: 1000n, currency: 'USD' });
  await ctx.payments.attachPaymentMethod(m, transfer.id, 'zelle');
  const waiting = await ctx.payments.confirm(m, transfer.id, {});
  assert.equal(waiting.status, 'requires_action');

  const off = await caps.setMerchantEnabled(m, 'zelle', false, 'user:u1');
  assert.equal(off.state, 'disabled');

  await assert.rejects(ctx.payments.create(m, { amount: 1000n, currency: 'USD', paymentMethodTypes: ['zelle'] }), code('payment_method_not_allowed'));
  const fresh = await ctx.payments.create(m, { amount: 1000n, currency: 'USD' });
  await assert.rejects(ctx.payments.attachPaymentMethod(m, fresh.id, 'zelle'), code('payment_method_disabled'));
  await assert.rejects(ctx.payments.confirm(m, ready.id, {}), code('payment_method_disabled'));
  assert.ok(!(await ctx.payments.availableMethods(fresh)).some((x) => x.type === 'zelle'));

  // La transferencia que ya esperaba el dinero se acredita igual
  const done = await ctx.payments.applyRailResult(transfer.id, { status: 'succeeded', reference: 'ZL-1' }, 'worker:test');
  assert.equal(done.status, 'succeeded');

  // Auditoría y webhook del cambio
  const audit = await ctx.pool.query('SELECT actor, before->>\'state\' AS b, after->>\'state\' AS a FROM merchants.capability_changes WHERE merchant_id = $1', [m]);
  assert.deepEqual(audit.rows, [{ actor: 'user:u1', b: 'active', a: 'disabled' }]);
  const ev = await ctx.pool.query("SELECT 1 FROM webhooks.events WHERE merchant_id = $1 AND type = 'account.capability.updated'", [m]);
  assert.equal(ev.rowCount, 1);
  await assert.rejects(ctx.pool.query('DELETE FROM merchants.capability_changes WHERE merchant_id = $1', [m]));

  assert.equal((await caps.setMerchantEnabled(m, 'zelle', true, 'user:u1')).state, 'active');
  assert.equal((await ctx.payments.attachPaymentMethod(m, fresh.id, 'zelle')).status, 'requires_confirmation');
});

test('lista de métodos por pago: solo se puede elegir uno de la lista', async () => {
  const m = await ctx.merchant('acct_caps_list');
  const pi = await ctx.payments.create(m, { amount: 1000n, currency: 'USD', paymentMethodTypes: ['usdt_trc20', 'pago_movil_c2p'] });
  assert.deepEqual(pi.payment_method_types, ['usdt_trc20', 'pago_movil_c2p']);
  assert.deepEqual((await ctx.payments.availableMethods(pi)).map((x) => x.type).sort(), ['pago_movil_c2p', 'usdt_trc20']);
  await assert.rejects(ctx.payments.attachPaymentMethod(m, pi.id, 'zelle'), code('payment_method_not_allowed'));
  assert.equal((await ctx.payments.attachPaymentMethod(m, pi.id, 'usdt_trc20')).charge_currency, 'USDT');
});

test('la plataforma bloquea a un comercio o apaga un método para todos; el comercio no lo puede reencender', async () => {
  const a = await ctx.merchant('acct_caps_a');
  const b = await ctx.merchant('acct_caps_b');
  assert.equal((await caps.platformSetForMerchant(a, 'cash', { platform_status: 'blocked' }, 'platform:riesgo')).state, 'blocked');
  await assert.rejects(caps.setMerchantEnabled(a, 'cash', true, 'user:x'), code('capability_locked'));
  assert.equal((await caps.list(b)).find((c) => c.key === 'cash')!.state, 'active');

  await caps.platformSetGlobal('usdt_polygon', { global_enabled: false }, 'platform:ops');
  for (const m of [a, b]) {
    const pi = await ctx.payments.create(m, { amount: 1000n, currency: 'USD' });
    await assert.rejects(ctx.payments.attachPaymentMethod(m, pi.id, 'usdt_polygon'), code('payment_method_disabled'));
  }
  await caps.platformSetGlobal('usdt_polygon', { global_enabled: true }, 'platform:ops');
});

test('precio y límites negociados por comercio se aplican al cotizar', async () => {
  const m = await ctx.merchant('acct_caps_price');
  await caps.platformSetForMerchant(m, 'zelle', { fee_bps: 100, fee_fixed_usd: 0, min_amount: 500, max_amount: 50000 }, 'platform:ventas');
  const view = (await caps.list(m)).find((c) => c.key === 'zelle')!;
  assert.equal(view.custom_pricing, true);
  assert.equal(view.fee_bps, 100);

  const pi = await ctx.payments.create(m, { amount: 10000n, currency: 'USD' });
  const att = await ctx.payments.attachPaymentMethod(m, pi.id, 'zelle');
  assert.equal(att.fee_amount, 100n); // 1 % de 100,00 USD, sin fijo
  const small = await ctx.payments.create(m, { amount: 100n, currency: 'USD' });
  await assert.rejects(ctx.payments.attachPaymentMethod(m, small.id, 'zelle'), code('amount_out_of_range'));
  await assert.rejects(caps.platformSetForMerchant(m, 'zelle', { min_amount: 900, max_amount: 800 }, 'platform:x'), code('capability_invalid'));
  await assert.rejects(caps.platformSetForMerchant(m, 'webhooks', { fee_bps: 1 }, 'platform:x'), code('capability_invalid'));
});

test('sin ningún método activo no se crean pagos', async () => {
  const m = await ctx.merchant('acct_caps_none');
  for (const s of await methodSettings(ctx.pool, m)) await caps.setMerchantEnabled(m, s.type, false, 'user:x');
  assert.equal(allowedFor(await methodSettings(ctx.pool, m), null).length, 0);
  await assert.rejects(ctx.payments.create(m, { amount: 1000n, currency: 'USD' }), code('no_payment_methods_available'));
});

test('módulos: con links de pago o webhooks apagados se rechazan sus operaciones y no se programan entregas', async () => {
  const m = await ctx.merchant('acct_caps_mod');
  const dash = new DashboardService(ctx.pool, ctx.merchants, ctx.payments);
  const hooks = new WebhooksService(ctx.pool);
  process.env.WEBHOOK_ALLOW_HTTP = 'true';
  process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
  try {
    const ep = await hooks.createEndpoint(m, 'http://127.0.0.1:9/hook', ['*']);
    await caps.setMerchantEnabled(m, 'webhooks', false, 'user:x');
    await assert.rejects(hooks.createEndpoint(m, 'http://127.0.0.1:9/otro', ['*']), code('feature_disabled'));
    await assert.rejects(hooks.sendTest(m, ep.id, false), code('feature_disabled'));
    const pi = await ctx.payments.create(m, { amount: 1000n, currency: 'USD' });
    const d = await ctx.pool.query('SELECT 1 FROM webhooks.deliveries d JOIN webhooks.events e ON e.id = d.event_id WHERE e.object_id = $1', [pi.id]);
    assert.equal(d.rowCount, 0); // el evento existe, pero no se entrega
    assert.equal((await ctx.pool.query('SELECT 1 FROM webhooks.events WHERE object_id = $1', [pi.id])).rowCount, 1);
  } finally {
    delete process.env.WEBHOOK_ALLOW_HTTP;
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
  }

  const link = (await dash.createLink(m, { amount: '100', currency: 'USD', description: 'Solo USDT', payment_method_types: ['usdt_trc20'] }, ''))!;
  assert.deepEqual(link.payment_method_types, ['usdt_trc20']);
  await caps.setMerchantEnabled(m, 'usdt_trc20', false, 'user:x');
  await assert.rejects(dash.createLink(m, { amount: '100', currency: 'USD', description: 'x', payment_method_types: ['usdt_trc20'] }, ''), code('payment_method_not_allowed'));
});

test('la BD no acepta capacidades inventadas ni límites incoherentes', async () => {
  const m = await ctx.merchant('acct_caps_db');
  const e1 = await pgError(ctx.pool.query(`INSERT INTO merchants.capabilities (merchant_id, key, updated_by) VALUES ($1, 'bitcoin', 'x')`, [m]));
  assert.equal(e1.code, '23503');
  const e2 = await pgError(ctx.pool.query(`UPDATE merchants.capabilities SET min_amount = 10, max_amount = 5 WHERE merchant_id = $1 AND key = 'zelle'`, [m]));
  assert.equal(e2.code, '23514');
});

test('liquidación en divisas: con el módulo apagado no se guarda la regla y el corte espera', async () => {
  const m = await ctx.merchant('acct_caps_settle');
  const usdt = { targetCurrency: 'USDT' as const, bps: 4000, destination: { network: 'TRON', address: 'TX' } };
  const ves = { targetCurrency: 'VES' as const, bps: 6000, destination: { bank: '0102', account: '01020000000000000000' } };
  await ctx.merchants.setSettlementRules(m, 'VES', [ves, usdt]);

  let pi = await ctx.payments.create(m, { amount: 10000n, currency: 'USD' });
  pi = await ctx.payments.attachPaymentMethod(m, pi.id, 'pago_movil_c2p');
  pi = await ctx.payments.confirm(m, pi.id, { phone: '04141234567', bank: '0102', otp: '1' });
  await ctx.settlements.recordRailFunds('c2p_settle_1', 'ves_c2p', 'VES', [pi.id]);

  await caps.platformSetForMerchant(m, 'settlement_usdt', { platform_status: 'blocked' }, 'platform:cumplimiento');
  await assert.rejects(ctx.merchants.setSettlementRules(m, 'VES', [ves, usdt]), code('feature_disabled'));
  // Bolívares y la misma moneda no necesitan módulo
  await ctx.merchants.setSettlementRules(m, 'USD', [{ targetCurrency: 'VES', bps: 10000, destination: {} }]);

  const r = await ctx.settlements.runCutoff('2026-10-19-VES-caps', { sourceCurrency: 'VES' });
  assert.deepEqual(r.skipped.filter((s) => s.merchantId === m), [{ merchantId: m, reason: 'settlement_module_disabled' }]);
  assert.equal((await ctx.payments.retrieve(m, pi.id)).status, 'succeeded'); // sigue esperando, no se pierde

  await caps.platformSetForMerchant(m, 'settlement_usdt', { platform_status: 'allowed' }, 'platform:cumplimiento');
  await withTransaction(ctx.pool, (c) => ctx.ledger.post(c, {
    idempotencyKey: 'treasury:usdt:caps', kind: 'capital_contribution', description: 'Aporte de capital en USDT (prueba)',
    lines: [
      { accountCode: 'platform:cash:USDT', currency: 'USDT', amount: 1_000_000_000n },
      { accountCode: 'platform:fx_position:USDT', currency: 'USDT', amount: -1_000_000_000n },
    ],
  }));
  const r2 = await ctx.settlements.runCutoff('2026-10-19-VES-caps-2', { sourceCurrency: 'VES' });
  assert.deepEqual(r2.skipped.filter((s) => s.merchantId === m), []);
  assert.ok(r2.payouts.some((p) => p.merchantId === m));
});

test('panel interno: bandeja de solicitudes y catálogo con conteos', async () => {
  const m = await ctx.merchant('acct_caps_inbox');
  await caps.platformSetForMerchant(m, 'banesco_panama', { platform_status: 'blocked' }, 'platform:x');
  await ctx.pool.query(`DELETE FROM merchants.capabilities WHERE merchant_id = $1 AND key = 'settlement_usd'`, [m]);
  await caps.request(m, 'settlement_usd', 'user:x');
  const inbox = await caps.pendingRequests();
  const mine = inbox.find((r) => r.merchant_id === m)!;
  assert.equal(mine.key, 'settlement_usd');
  assert.equal(mine.name, 'Liquidar en dólares');
  assert.equal(mine.business_name, `Comercio ${m}`);

  const globals = await caps.listGlobal();
  assert.equal(globals[0].key, 'pago_movil_c2p'); // orden del catálogo
  const usd = globals.find((g) => g.key === 'settlement_usd')!;
  assert.ok(usd.pending >= 1);
  await caps.platformSetForMerchant(m, 'settlement_usd', { platform_status: 'allowed' }, 'platform:x');
  assert.ok(!(await caps.pendingRequests()).some((r) => r.merchant_id === m));
});

test('Banesco Panamá en el sandbox: espera la transferencia con los datos de la cuenta', async () => {
  const m = await ctx.merchant('acct_caps_bpa');
  let pi = await ctx.payments.create(m, { amount: 5000n, currency: 'USD' });
  pi = await ctx.payments.attachPaymentMethod(m, pi.id, 'banesco_panama');
  pi = await ctx.payments.confirm(m, pi.id, {});
  assert.equal(pi.status, 'requires_action');
  assert.equal(pi.next_action?.type, 'bank_transfer');
  assert.equal(pi.next_action?.amount, pi.charge_amount!.toString());
});
