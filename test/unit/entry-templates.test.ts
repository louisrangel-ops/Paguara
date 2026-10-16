import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merchantPayoutEntry, paymentCaptureEntry, railFundsReceivedEntry } from '../../src/ledger/entry-templates';
import { assertBalanced, UnbalancedEntryError } from '../../src/ledger/ledger.types';
import { computeBreakdown } from '../../src/payment-intents/pricing';
import { PAYMENT_METHODS } from '../../src/payment-intents/payment-methods';

test('comisión Pago Móvil: 1,5 % + 0,05 USD a tasa congelada + IVA 16 % sobre la comisión', () => {
  // 100 USD a 36,5 → 3.650,00 Bs; fijo 0,05 USD × 36,5 = 1,825 Bs → 1,82 (half-even)
  const b = computeBreakdown(365000n, PAYMENT_METHODS.pago_movil_c2p, 182n);
  assert.equal(b.fee, 5475n + 182n);            // 54,75 + 1,82 = 56,57 Bs
  assert.equal(b.tax, 905n);                    // 16 % de 56,57 = 9,0512 → 9,05
  assert.equal(b.net, 365000n - 5657n - 905n);  // 3.584,38 Bs
});

test('IGTF 3 % solo en divisas en efectivo, cobrado encima del precio', () => {
  const cash = computeBreakdown(10000n, PAYMENT_METHODS.cash, 25n);
  assert.equal(cash.igtf, 300n);                 // 3 % de 100,00 USD
  assert.equal(cash.charge, 10300n);             // el pagador entrega 103,00 USD
  assert.equal(cash.net, 10000n - 225n);         // el comercio recibe su precio menos la comisión
  for (const m of ['zelle', 'card_international', 'usdt_trc20', 'pago_movil_c2p'] as const) {
    assert.equal(computeBreakdown(10000n, PAYMENT_METHODS[m], 0n).igtf, 0n, m);
  }
  const d = paymentCaptureEntry({ paymentIntentId: 'pi_c', merchantId: 'm_1', rail: 'cash_network', chargeCurrency: 'USD',
    chargeAmount: cash.charge, feeAmount: cash.fee, taxAmount: cash.tax, netAmount: cash.net, igtfAmount: cash.igtf });
  assertBalanced(d.lines);
  assert.equal(d.lines.find((l) => l.accountCode === 'platform:tax_payable:igtf:USD')!.amount, -300n);
});

test('el asiento de captura cuadra y omite partidas en cero', () => {
  const d = paymentCaptureEntry({ paymentIntentId: 'pi_1', merchantId: 'm_1', rail: 'zelle', chargeCurrency: 'USD',
    chargeAmount: 10000n, feeAmount: 275n, taxAmount: 0n, netAmount: 9725n });
  assert.equal(d.lines.length, 3);
  assert.equal(d.idempotencyKey, 'capture:pi_1');
  assertBalanced(d.lines);
});

test('fondos recibidos agrupan el neto por comercio', () => {
  const d = railFundsReceivedEntry('lote_1', 'ves_c2p', 'VES', [
    { merchantId: 'm_1', chargeAmount: 1000n, netAmount: 900n },
    { merchantId: 'm_1', chargeAmount: 2000n, netAmount: 1800n },
    { merchantId: 'm_2', chargeAmount: 500n, netAmount: 450n },
  ]);
  assert.equal(d.lines.length, 2 + 4);
  assert.equal(d.lines.find((l) => l.accountCode === 'merchant:m_1:available:VES')!.amount, -2700n);
});

test('liquidación split 60 % VES / 40 % USDT cuadra por moneda y registra el spread como ingreso', () => {
  const quote = { id: 'fxq_1', base: 'USDT' as const, quote: 'VES' as const, rate: '38.2', source: 'BINANCE_P2P', expiresAt: new Date() };
  const { draft, legs } = merchantPayoutEntry('payout:k', 'po_1', 'm_1', 'VES', 357471n, [
    { currency: 'VES', bps: 6000 },
    { currency: 'USDT', bps: 4000, quote, spreadBps: 120 },
  ]);
  assertBalanced(draft.lines);
  assert.equal(legs[0].amount, 214482n);
  assert.equal(legs[1].sourceAmount, 142989n);
  assert.equal(legs[1].spread, 1716n);                       // 1,2 % de 1.429,89 = 17,15868 → 17,16
  assert.equal(legs[1].amount, 36_982_461n);                 // 1.412,73 Bs / 38,2
  assert.equal(draft.lines.find((l) => l.accountCode === 'platform:fx_spread_revenue:VES')!.amount, -1716n);

  const noSpread = merchantPayoutEntry('payout:k2', 'po_2', 'm_1', 'VES', 357471n, [{ currency: 'USDT', bps: 10000, quote }]);
  assert.ok(!noSpread.draft.lines.some((l) => l.accountCode.includes('fx_spread_revenue')));
});

test('un asiento descuadrado o con monedas mezcladas se rechaza antes de tocar la BD', () => {
  assert.throws(() => assertBalanced([
    { accountCode: 'platform:cash:VES', currency: 'VES', amount: 100n },
    { accountCode: 'platform:cash:USD', currency: 'USD', amount: -100n },
  ]), UnbalancedEntryError);
  assert.throws(() => assertBalanced([
    { accountCode: 'platform:cash:VES', currency: 'USD', amount: 100n },
    { accountCode: 'platform:cash:USD', currency: 'USD', amount: -100n },
  ]), UnbalancedEntryError);
});
