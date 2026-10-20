import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRails } from '../../src/app.module';
import { isInternalPath, rateRules } from '../../src/common/hardening';
import { openSecret, sealSecret } from '../../src/common/secret-box';

const req = (path: string, auth?: string) => ({ path, ip: '10.0.0.1', header: (h: string) => (h === 'authorization' ? auth : undefined) }) as never;

test('producción no arranca con rieles de prueba; el sandbox sí', () => {
  assert.throws(() => buildRails(true), /rieles de prueba/);
  assert.ok(buildRails(false).size > 0);
});

test('rutas internas: /internal y /admin, nada más', () => {
  for (const p of ['/internal', '/internal/payouts/pending', '/admin', '/admin/']) assert.ok(isInternalPath(p), p);
  for (const p of ['/', '/administracion', '/internalx', '/v1/payment_intents', '/api/dashboard/me']) assert.ok(!isInternalPath(p), p);
});

test('límite de peticiones: la API cuenta por llave y por IP; checkout y panel por IP; lo interno no se limita', () => {
  const [a, aIp] = rateRules(req('/v1/payment_intents', 'Bearer sk_test_1'), {});
  const [b, bIp] = rateRules(req('/v1/payment_intents', 'Bearer sk_test_2'), {});
  assert.equal(a.limit, 600);
  assert.notEqual(a.bucket, b.bucket);
  assert.ok(!a.bucket.includes('sk_test'), 'la llave no se guarda en Redis');
  // Una llave inventada distinta en cada petición no escapa del tope por IP
  assert.deepEqual(aIp, { bucket: 'ip:10.0.0.1:api', limit: 3000 });
  assert.deepEqual(bIp, aIp);
  assert.deepEqual(rateRules(req('/v1/payment_intents'), { RATE_LIMIT_API_IP_PER_MIN: '100' }), [{ bucket: 'ip:10.0.0.1:api', limit: 100 }]);
  assert.deepEqual(rateRules(req('/v1/checkout/payment_intents/pi_1'), {}), [{ bucket: 'ip:10.0.0.1:checkout', limit: 120 }]);
  assert.deepEqual(rateRules(req('/api/dashboard/login'), { RATE_LIMIT_DASHBOARD_PER_MIN: '50' }), [{ bucket: 'ip:10.0.0.1:dashboard', limit: 50 }]);
  assert.deepEqual(rateRules(req('/internal/fx/rates'), {}), []);
  assert.deepEqual(rateRules(req('/health'), {}), []);
});

test('secretos de webhooks: cifrados con la llave, legibles de vuelta, y los viejos en claro siguen sirviendo', () => {
  const prev = process.env.SECRETS_ENCRYPTION_KEY;
  try {
    process.env.SECRETS_ENCRYPTION_KEY = 'c'.repeat(64);
    const sealed = sealSecret('whsec_abc');
    assert.match(sealed, /^enc:v1:/);
    assert.ok(!sealed.includes('whsec_abc'));
    assert.notEqual(sealSecret('whsec_abc'), sealed, 'cada cifrado usa un IV nuevo');
    assert.equal(openSecret(sealed), 'whsec_abc');
    assert.equal(openSecret('whsec_viejo'), 'whsec_viejo');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'AB' : 'AA');
    assert.throws(() => openSecret(tampered));
    process.env.SECRETS_ENCRYPTION_KEY = 'd'.repeat(64);
    assert.throws(() => openSecret(sealed), 'otra llave no lo abre');
  } finally {
    if (prev === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = prev;
  }
});
