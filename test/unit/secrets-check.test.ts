import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployedConfigProblems } from '../../src/common/secrets-check';

const strong = 'a'.repeat(64);
const key = 'b'.repeat(64);
const deployed = { COOKIE_SECURE: 'true', INTERNAL_API_TOKEN: strong, SECRETS_ENCRYPTION_KEY: key };
const live = { ...deployed, LIVEMODE: 'true', PORT: '3000', INTERNAL_PORT: '3001', KMS_PROVIDER: 'aws', KMS_KEY_ID: 'alias/paguara' };

test('en local (COOKIE_SECURE=false) se acepta el token de desarrollo', () => {
  assert.deepEqual(deployedConfigProblems({ COOKIE_SECURE: 'false', INTERNAL_API_TOKEN: 'dev-internal-token' }), []);
});

test('desplegado: rechaza los tokens de las plantillas, los cortos y la ausencia de token', () => {
  for (const t of ['cambia-esto', 'dev-internal-token', 'corto', undefined]) {
    assert.equal(deployedConfigProblems({ ...deployed, INTERNAL_API_TOKEN: t }).length, 1, String(t));
  }
  assert.equal(deployedConfigProblems({ INTERNAL_API_TOKEN: 'cambia-esto', SECRETS_ENCRYPTION_KEY: key }).length, 1, 'COOKIE_SECURE sin definir cuenta como desplegado');
});

test('desplegado con token propio y llave de cifrado no tiene problemas', () => {
  assert.deepEqual(deployedConfigProblems(deployed), []);
});

test('desplegado exige la llave que cifra los secretos de webhooks', () => {
  for (const k of [undefined, 'corta', 'z'.repeat(64)]) {
    assert.match(deployedConfigProblems({ ...deployed, SECRETS_ENCRYPTION_KEY: k }).join(), /SECRETS_ENCRYPTION_KEY/, String(k));
  }
});

test('LIVEMODE=true no admite cookies sin Secure aunque el token sea bueno', () => {
  assert.equal(deployedConfigProblems({ ...live, COOKIE_SECURE: 'false' }).length, 1);
});

test('LIVEMODE=true exige puerto interno separado y doble aprobación de liquidaciones', () => {
  assert.deepEqual(deployedConfigProblems(live), []);
  assert.match(deployedConfigProblems({ ...live, INTERNAL_PORT: undefined }).join(), /INTERNAL_PORT/);
  assert.match(deployedConfigProblems({ ...live, INTERNAL_PORT: '3000' }).join(), /INTERNAL_PORT/);
  assert.match(deployedConfigProblems({ ...live, PAYOUT_APPROVALS_REQUIRED: '1' }).join(), /PAYOUT_APPROVALS_REQUIRED/);
  assert.deepEqual(deployedConfigProblems({ ...live, PAYOUT_APPROVALS_REQUIRED: '3' }), []);
});

test('gestor de llaves: la llave local no se acepta en producción; AWS exige el id de la llave', () => {
  assert.match(deployedConfigProblems({ ...live, KMS_PROVIDER: undefined }).join(), /KMS_PROVIDER=local no se permite/);
  assert.match(deployedConfigProblems({ ...live, KMS_KEY_ID: undefined }).join(), /KMS_KEY_ID/);
  assert.match(deployedConfigProblems({ ...live, KMS_PROVIDER: 'vault' }).join(), /desconocido/);
  // Con AWS la llave local es opcional (solo para leer lo cifrado antes de migrar)
  assert.deepEqual(deployedConfigProblems({ ...live, SECRETS_ENCRYPTION_KEY: undefined }), []);
  assert.match(deployedConfigProblems({ ...live, SECRETS_ENCRYPTION_KEY: 'corta' }).join(), /SECRETS_ENCRYPTION_KEY/);
  assert.match(deployedConfigProblems({ ...deployed, SECRETS_ENCRYPTION_PREVIOUS_KEYS: 'mala' }).join(), /PREVIOUS_KEYS/);
  assert.deepEqual(deployedConfigProblems({ ...deployed, SECRETS_ENCRYPTION_PREVIOUS_KEYS: 'c'.repeat(64) }), []);
});
