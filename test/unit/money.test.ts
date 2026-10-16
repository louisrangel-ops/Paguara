import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateByBps, applyBps, convert, divRoundHalfEven, parseRate, formatRate } from '../../src/common/money';
import { convertWithQuote } from '../../src/fx/fx.math';

test('convierte USD→VES con tasa BCV exacta', () => {
  assert.equal(convert(10000n, 'USD', 'VES', '36.5'), 365000n);          // 100,00 USD → 3.650,00 Bs
  assert.equal(convert(1999n, 'USD', 'VES', '36.4512'), 72866n);          // 19,99 × 36,4512 = 728,659488 → 728,66
});

test('ajusta exponentes distintos (USDT tiene 6 decimales)', () => {
  assert.equal(convert(10000n, 'USD', 'USDT', '1'), 100_000_000n);        // 100,00 USD → 100,000000 USDT
  assert.equal(convert(1_000_000n, 'USDT', 'VES', '38.2'), 3820n);        // 1 USDT → 38,20 Bs
});

test('convierte en sentido inverso sin invertir la tasa', () => {
  const q = { base: 'USD' as const, quote: 'VES' as const, rate: '36.5' };
  assert.equal(convertWithQuote(365000n, 'VES', 'USD', q), 10000n);
  assert.equal(convertWithQuote(10000n, 'USD', 'VES', q), 365000n);
  const usdt = { base: 'USDT' as const, quote: 'VES' as const, rate: '38.2' };
  assert.equal(convertWithQuote(142988n, 'VES', 'USDT', usdt), 37_431_414n); // 1.429,88 Bs / 38,2 = 37,4314136...
});

test('redondeo bancario half-even', () => {
  assert.equal(divRoundHalfEven(25n, 10n), 2n);
  assert.equal(divRoundHalfEven(35n, 10n), 4n);
  assert.equal(divRoundHalfEven(26n, 10n), 3n);
  assert.equal(applyBps(10050n, 150), 151n); // 150,75 → 151 (impar sube)
});

test('tasas: se parsean con 12 decimales y se rechaza basura', () => {
  assert.equal(formatRate(parseRate('36.500')), '36.5');
  assert.throws(() => parseRate('36,5'));
  assert.throws(() => parseRate('-1'));
  assert.throws(() => parseRate('0'));
  assert.throws(() => parseRate('1.0000000000001'));
});

test('el split no crea ni pierde céntimos', () => {
  for (const total of [1n, 7n, 357471n, 999999999n]) {
    const parts = allocateByBps(total, [6000, 4000]);
    assert.equal(parts[0] + parts[1], total);
  }
  assert.deepEqual(allocateByBps(357471n, [3333, 3333, 3334]).reduce((a, b) => a + b), 357471n);
  assert.throws(() => allocateByBps(100n, [5000, 4000]));
});
