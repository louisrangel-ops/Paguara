import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, base32Encode, currentStep, hashRecoveryCode, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode,
  otpauthUrl, totpCode, verifyTotp } from '../../src/mfa/totp';
import { parseAmount, parseDate, parseStatementCsv } from '../../src/reconciliation/statement-parser';
import { yesterdayInCaracas } from '../../src/reconciliation/reconciliation.service';

// Vectores del RFC 6238 (SHA-1, semilla "12345678901234567890"), últimos 6 dígitos
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('TOTP: coincide con los vectores del RFC 6238', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode(RFC_SECRET).toString(), '12345678901234567890');
  assert.equal(totpCode(RFC_SECRET, currentStep(59_000)), '287082');
  assert.equal(totpCode(RFC_SECRET, currentStep(1111111109_000)), '081804');
  assert.equal(totpCode(RFC_SECRET, currentStep(1234567890_000)), '005924');
  assert.equal(totpCode(RFC_SECRET, currentStep(2000000000_000)), '279037');
});

test('TOTP: acepta un paso de desfase, no más, y nunca un paso ya usado', () => {
  const now = 1_700_000_000_000;
  const step = currentStep(now);
  const s = newTotpSecret();
  assert.equal(s.length, 32);
  assert.equal(verifyTotp(s, totpCode(s, step), { nowMs: now }), step);
  assert.equal(verifyTotp(s, totpCode(s, step - 1), { nowMs: now }), step - 1);
  assert.equal(verifyTotp(s, totpCode(s, step + 1), { nowMs: now }), step + 1);
  assert.equal(verifyTotp(s, totpCode(s, step - 3), { nowMs: now }), null);
  assert.equal(verifyTotp(s, totpCode(s, step), { nowMs: now, afterStep: step }), null, 'el mismo código no vale dos veces');
  assert.equal(verifyTotp(s, 'abcdef', { nowMs: now }), null);
  assert.equal(verifyTotp(s, '12345', { nowMs: now }), null);
});

test('enlace otpauth para el QR', () => {
  const url = otpauthUrl('JBSWY3DPEHPK3PXP', 'ana@cafe.com');
  assert.equal(url, 'otpauth://totp/Paguara%3Aana%40cafe.com?secret=JBSWY3DPEHPK3PXP&issuer=Paguara&algorithm=SHA1&digits=6&period=30');
});

test('códigos de respaldo: 10 distintos, se aceptan con o sin guion y en mayúsculas', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  const c = codes[0];
  assert.equal(normalizeRecoveryCode(c.toUpperCase().replace('-', ' ')), c);
  assert.equal(hashRecoveryCode(c.replace('-', '')), hashRecoveryCode(c));
  assert.equal(normalizeRecoveryCode('corto'), '');
});

test('extracto: montos del banco sin float, en cualquiera de los formatos comunes', () => {
  assert.equal(parseAmount('3650.00', 'VES'), 365000n);
  assert.equal(parseAmount('3.650,00', 'VES'), 365000n);
  assert.equal(parseAmount('3,650.00', 'VES'), 365000n);
  assert.equal(parseAmount('3650,5', 'VES'), 365050n);
  assert.equal(parseAmount('-12,34', 'VES'), -1234n);
  assert.equal(parseAmount('(12.34)', 'USD'), -1234n);
  assert.equal(parseAmount('25.123456', 'USDT'), 25123456n);
  assert.throws(() => parseAmount('1.234', 'VES'), /Monto inválido/, 'tres decimales en bolívares es ambiguo: se rechaza');
  assert.throws(() => parseAmount('abc', 'VES'));
  assert.equal(parseDate('20/10/2026'), '2026-10-20');
  assert.equal(parseDate('2026-10-20'), '2026-10-20');
  assert.throws(() => parseDate('2026-02-30'));
});

test('extracto en CSV con punto y coma, comillas y encabezados en español', () => {
  const csv = '﻿Fecha;Referencia;Monto;Descripción\r\n20/10/2026;000123;"3.650,00";"Pago Móvil; cliente"\r\n20/10/2026;000124;-10,00;Comisión\r\n';
  assert.deepEqual(parseStatementCsv(csv, 'VES'), [
    { valueDate: '2026-10-20', amount: 365000n, reference: '000123', description: 'Pago Móvil; cliente' },
    { valueDate: '2026-10-20', amount: -1000n, reference: '000124', description: 'Comisión' },
  ]);
  assert.throws(() => parseStatementCsv('fecha,monto\n2026-10-20,1', 'VES'), /columnas/);
  assert.throws(() => parseStatementCsv('fecha,referencia,monto\n2026-10-20,,1', 'VES'), /Línea 2/);
});

test('el job de la mañana concilia el día anterior en hora de Caracas', () => {
  // 02:00 UTC del 21 = 22:00 del 20 en Caracas: "ayer" es el 19
  assert.equal(yesterdayInCaracas(new Date('2026-10-21T02:00:00Z')), '2026-10-19');
  assert.equal(yesterdayInCaracas(new Date('2026-10-21T10:00:00Z')), '2026-10-20');
});
