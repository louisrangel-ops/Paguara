import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployedConfigProblems } from '../../src/common/secrets-check';

const strong = 'a'.repeat(64);

test('en local (COOKIE_SECURE=false) se acepta el token de desarrollo', () => {
  assert.deepEqual(deployedConfigProblems({ COOKIE_SECURE: 'false', INTERNAL_API_TOKEN: 'dev-internal-token' }), []);
});

test('desplegado: rechaza los tokens de las plantillas, los cortos y la ausencia de token', () => {
  for (const t of ['cambia-esto', 'dev-internal-token', 'corto', undefined]) {
    assert.equal(deployedConfigProblems({ COOKIE_SECURE: 'true', INTERNAL_API_TOKEN: t }).length, 1, String(t));
  }
  assert.equal(deployedConfigProblems({ INTERNAL_API_TOKEN: 'cambia-esto' }).length, 1, 'COOKIE_SECURE sin definir cuenta como desplegado');
});

test('desplegado con token propio no tiene problemas', () => {
  assert.deepEqual(deployedConfigProblems({ COOKIE_SECURE: 'true', INTERNAL_API_TOKEN: strong }), []);
});

test('LIVEMODE=true no admite cookies sin Secure aunque el token sea bueno', () => {
  assert.equal(deployedConfigProblems({ LIVEMODE: 'true', COOKIE_SECURE: 'false', INTERNAL_API_TOKEN: strong }).length, 1);
});
