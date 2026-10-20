import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Ctx, setup } from './helpers';
import { Iso8583SimulatorRail } from '../../src/payment-intents/rails/iso8583/simulator.rail';

let ctx: Ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });

async function newCardPayment(merchant: string, amount = 15_000n) {
  let pi = await ctx.payments.create(merchant, { amount, currency: 'VES', paymentMethodTypes: ['card_national'] });
  assert.equal(pi.status, 'requires_payment_method');
  pi = await ctx.payments.attachPaymentMethod(merchant, pi.id, 'card_national');
  assert.equal(pi.status, 'requires_confirmation');
  assert.equal(pi.rail, 'ves_card_switch');
  return pi;
}

test('E2E ISO8583: PaymentIntent -> 0100/0110 -> succeeded -> ledger -> conciliacion', async () => {
  const merchant = await ctx.merchant('acct_iso_e2e_ok');
  const rail = new Iso8583SimulatorRail('approve');
  ctx.rails.set('ves_card_switch', rail);

  let pi = await newCardPayment(merchant);
  pi = await ctx.payments.confirm(merchant, pi.id, { token: 'tok_test_only' });

  assert.equal(pi.status, 'succeeded');
  assert.ok(pi.capture_entry_id);
  assert.match(pi.rail_reference ?? '', /^\\d{12}$/);

  const entries = await ctx.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ledger.journal_entries WHERE kind = 'payment_capture' AND reference_id = $1", [pi.id]);
  assert.equal(entries.rows[0].n, 1);

  const snapshot = rail.reconciliationSnapshot();
  assert.equal(snapshot.approved, 1);
  assert.equal(snapshot.declined, 0);
  assert.equal(snapshot.reversed, 0);
  assert.equal(snapshot.netApprovedMinor, pi.charge_amount);
});

test('E2E ISO8583: rechazo emisor vuelve a requires_payment_method y no captura ledger', async () => {
  const merchant = await ctx.merchant('acct_iso_e2e_decline');
  const rail = new Iso8583SimulatorRail('decline');
  ctx.rails.set('ves_card_switch', rail);

  let pi = await newCardPayment(merchant);
  pi = await ctx.payments.confirm(merchant, pi.id, { token: 'tok_test_only' });

  assert.equal(pi.status, 'requires_payment_method');
  assert.equal((pi.last_payment_error as { code?: string } | null)?.code, 'do_not_honor');
  assert.equal(pi.capture_entry_id, null);

  const entries = await ctx.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ledger.journal_entries WHERE kind = 'payment_capture' AND reference_id = $1", [pi.id]);
  assert.equal(entries.rows[0].n, 0);
  assert.equal(rail.reconciliationSnapshot().declined, 1);
});

test('E2E ISO8583: timeout despues de aprobar queda processing; conciliacion lo completa una sola vez', async () => {
  const merchant = await ctx.merchant('acct_iso_e2e_timeout');
  const rail = new Iso8583SimulatorRail('timeout_after_approval');
  ctx.rails.set('ves_card_switch', rail);

  let pi = await newCardPayment(merchant);
  pi = await ctx.payments.confirm(merchant, pi.id, { token: 'tok_test_only' });

  assert.equal(pi.status, 'processing');
  assert.equal(pi.capture_entry_id, null);

  const attemptKey = `${pi.id}_${pi.version}`;
  const reconciled = rail.reconcileAttempt(attemptKey);
  assert.equal(reconciled.status, 'succeeded');

  pi = await ctx.payments.applyRailResult(pi.id, reconciled, 'reconciler:iso8583-test');
  assert.equal(pi.status, 'succeeded');
  assert.ok(pi.capture_entry_id);

  const same = await ctx.payments.applyRailResult(pi.id, reconciled, 'reconciler:iso8583-test');
  assert.equal(same.capture_entry_id, pi.capture_entry_id);

  const entries = await ctx.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM ledger.journal_entries WHERE kind = 'payment_capture' AND reference_id = $1", [pi.id]);
  assert.equal(entries.rows[0].n, 1);
  assert.equal(rail.reconciliationSnapshot().approved, 1);
});