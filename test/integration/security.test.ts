import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import { AuthService } from '../../src/dashboard/auth.service';
import { DashboardAuthController } from '../../src/dashboard/dashboard.controller';
import { MfaService } from '../../src/mfa/mfa.service';
import { currentStep, totpCode } from '../../src/mfa/totp';
import { LocalKeyProvider } from '../../src/secrets/kms';
import { RailCredentialsService } from '../../src/secrets/rail-credentials.service';
import { rewrapAll } from '../../src/secrets/rewrap';
import { SecretVault, setVaultForTests, vault } from '../../src/secrets/vault';
import { InternalAuthController } from '../../src/settlements/internal-auth.controller';
import { InternalTokenGuard } from '../../src/settlements/internal.controller';
import { OperatorsService } from '../../src/settlements/operators.service';
import { WebhooksService } from '../../src/webhooks/webhooks.service';
import { Ctx, pgError, seedRates, setup } from './helpers';

let ctx: Ctx;
let redis: Redis;
let auth: AuthService;
let mfa: MfaService;
let ops: OperatorsService;
const k1 = randomBytes(32);
const k2 = randomBytes(32);
const localVault = (active: Buffer, previous: Buffer[] = []) => { const p = new LocalKeyProvider(active, previous); return new SecretVault(p, p, [active, ...previous]); };

before(async () => {
  process.env.WEBHOOK_ALLOW_HTTP = 'true';
  process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
  setVaultForTests(localVault(k1));
  ctx = await setup();
  await seedRates(ctx.fx);
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  auth = new AuthService(ctx.pool, redis);
  mfa = new MfaService(ctx.pool, redis);
  ops = new OperatorsService(ctx.pool);
});
after(async () => {
  setVaultForTests(null);
  redis.disconnect();
  await ctx.teardown();
  delete process.env.WEBHOOK_ALLOW_HTTP;
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

const code = (c: string) => (e: { code: string }) => e.code === c;
const ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const fakeReq = (headers: Record<string, string> = {}) => ({
  method: 'POST', ip, socket: {}, header: (k: string) => ({ 'x-requested-with': 'fetch', ...headers })[k.toLowerCase()],
}) as never;
const fakeRes = () => { const h: Record<string, string> = {}; return { h, setHeader: (k: string, v: string) => { h[k] = v; } }; };
const now = () => currentStep();

test('2FA del comercio: inscripción, el código no se repite, códigos de respaldo de un solo uso', async () => {
  const { userId } = await auth.signup({ name: 'Ana', email: 'ana@mfa.test', password: 'una-clave-segura', business_name: 'Café', rif: 'J-30000001-1', accept_terms: true });
  const p = { type: 'user' as const, id: userId, label: 'ana@mfa.test' };
  assert.deepEqual(await mfa.status(p), { enabled: false, enabled_at: null, recovery_codes_left: 0 });
  await assert.rejects(mfa.confirmEnrollment(p, '123456', 'test'), code('mfa_enrollment_missing'));

  const { secret, otpauth_url } = await mfa.beginEnrollment(p);
  assert.match(otpauth_url, /^otpauth:\/\/totp\/Paguara%3Aana%40mfa\.test\?secret=/);
  const { rows: [stored] } = await ctx.pool.query('SELECT secret_sealed FROM security.mfa_factors WHERE principal_id = $1', [userId]);
  assert.match(stored.secret_sealed, /^env:v1:/);
  assert.ok(!stored.secret_sealed.includes(secret), 'la semilla está cifrada con el KMS');
  assert.equal(await mfa.isEnabled(p), false, 'a medias todavía no protege');

  const wrong = totpCode(secret, now() - 5);
  await assert.rejects(mfa.confirmEnrollment(p, wrong, 'test'), code('mfa_code_invalid'));
  const first = totpCode(secret, now());
  const { recovery_codes } = await mfa.confirmEnrollment(p, first, `user:${userId}`);
  assert.equal(recovery_codes.length, 10);
  assert.deepEqual((await mfa.status(p)).recovery_codes_left, 10);
  await assert.rejects(mfa.beginEnrollment(p), code('mfa_already_enabled'));

  await assert.rejects(mfa.verify(p, first, 'test'), code('mfa_code_invalid'), 'el código de la inscripción ya se usó');
  assert.equal(await mfa.verify(p, totpCode(secret, now() + 1), 'test'), 'totp');
  assert.equal(await mfa.verify(p, recovery_codes[0].toUpperCase(), 'test'), 'recovery_code');
  await assert.rejects(mfa.verify(p, recovery_codes[0], 'test'), code('mfa_code_invalid'), 'un código de respaldo se gasta');
  assert.equal((await mfa.status(p)).recovery_codes_left, 9);
  const { rows: stored2 } = await ctx.pool.query('SELECT code_hash FROM security.mfa_recovery_codes WHERE principal_id = $1 AND code_hash = $2', [userId, recovery_codes[1]]);
  assert.equal(stored2.length, 0, 'en la base solo está el hash');
  const { rows: audit } = await ctx.pool.query('SELECT action FROM security.mfa_audit WHERE principal_id = $1 ORDER BY id', [userId]);
  assert.deepEqual(audit.map((r) => r.action), ['enrolled', 'recovery_code_used']);
  assert.equal((await pgError(ctx.pool.query('DELETE FROM security.mfa_audit WHERE principal_id = $1', [userId]))).code, 'P0005');
});

test('2FA del comercio: con el factor activo la contraseña sola no abre sesión', async () => {
  const merchants = ctx.merchants;
  const ctl = new DashboardAuthController(auth, merchants, mfa);
  const { userId } = await auth.signup({ name: 'Beto', email: 'beto@mfa.test', password: 'una-clave-segura', business_name: 'Bodega', rif: 'J-30000002-2', accept_terms: true });
  const p = { type: 'user' as const, id: userId, label: 'beto@mfa.test' };

  // Sin doble factor: sesión directa
  let res = fakeRes();
  const plain = await ctl.login(fakeReq(), res as never, { email: 'beto@mfa.test', password: 'una-clave-segura' }) as { user: { mfa_enabled: boolean } };
  assert.equal(plain.user.mfa_enabled, false);
  assert.match(res.h['Set-Cookie'], /^sid=/);

  const { secret } = await mfa.beginEnrollment(p);
  await mfa.confirmEnrollment(p, totpCode(secret, now()), 'test');
  res = fakeRes();
  const step1 = await ctl.login(fakeReq(), res as never, { email: 'beto@mfa.test', password: 'una-clave-segura' }) as { mfa_required: boolean; mfa_token: string };
  assert.equal(step1.mfa_required, true);
  assert.equal(res.h['Set-Cookie'], undefined, 'sin sesión hasta el código');

  await assert.rejects(ctl.loginMfa(fakeReq(), fakeRes() as never, { mfa_token: 'mfa_' + 'x'.repeat(32), code: '000000' }), code('mfa_challenge_expired'));
  await assert.rejects(ctl.loginMfa(fakeReq(), fakeRes() as never, { mfa_token: step1.mfa_token, code: '000000' }), code('mfa_code_invalid'));
  res = fakeRes();
  const done = await ctl.loginMfa(fakeReq(), res as never, { mfa_token: step1.mfa_token, code: totpCode(secret, now() + 1) }) as { user: { mfa_enabled: boolean } };
  assert.equal(done.user.mfa_enabled, true);
  assert.match(res.h['Set-Cookie'], /^sid=/);
  await assert.rejects(ctl.loginMfa(fakeReq(), fakeRes() as never, { mfa_token: step1.mfa_token, code: totpCode(secret, now()) }), code('mfa_challenge_expired'),
    'el token del primer paso es de un solo uso');

  // Cinco códigos malos seguidos bloquean 15 minutos, también al código correcto
  for (let i = 0; i < 4; i++) await assert.rejects(mfa.verify(p, '000000', 'test'), code('mfa_code_invalid'));
  await assert.rejects(mfa.verify(p, '111111', 'test'), code('mfa_code_invalid'));
  await assert.rejects(mfa.verify(p, totpCode(secret, now()), 'test'), code('too_many_attempts'));

  // Reinicio por un maestro: quita el factor y cierra todas las sesiones
  await mfa.remove(p, 'platform:Ana', 'reset', 'Perdió el teléfono; verificado por videollamada');
  await auth.revokeAllSessions(userId);
  assert.equal(await mfa.isEnabled(p), false);
  const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM dashboard.sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  assert.equal(rows[0].n, 0);
  const { rows: audit } = await ctx.pool.query(`SELECT actor, reason FROM security.mfa_audit WHERE principal_id = $1 AND action = 'reset'`, [userId]);
  assert.deepEqual(audit, [{ actor: 'platform:Ana', reason: 'Perdió el teléfono; verificado por videollamada' }]);
});

test('panel interno: el token del operador solo no entra; con el código recibe una sesión corta', async () => {
  const ctl = new InternalAuthController(ops, mfa, redis);
  const guard = new InternalTokenGuard(ops);
  const guardCtx = (token: string) => {
    const req = { header: (k: string) => (k === 'x-internal-token' ? token : undefined) } as Record<string, unknown>;
    return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }) } as never };
  };
  const ana = await ops.create({ name: 'Ana', role: 'master' }, 'system');
  const g = guardCtx(ana.token);
  await assert.rejects(guard.canActivate(g.ctx), code('operator_session_required'));

  await assert.rejects(ctl.session(fakeReq(), { token: 'opk_' + '0'.repeat(48) }), code('unauthenticated'));
  const first = await ctl.session(fakeReq(), { token: ana.token }) as { mfa_enrollment_required: boolean };
  assert.equal(first.mfa_enrollment_required, true, 'la primera vez debe inscribir su app');
  const { secret } = await ctl.setup(fakeReq(), { token: ana.token });
  const enrolled = await ctl.confirm(fakeReq(), { token: ana.token, code: totpCode(secret, now()) });
  assert.match(enrolled.session, /^ops_/);
  assert.equal(enrolled.recovery_codes.length, 10);

  const s = guardCtx(enrolled.session);
  assert.equal(await guard.canActivate(s.ctx), true);
  assert.deepEqual(s.req.internalActor, { kind: 'operator', id: ana.id, name: 'Ana', role: 'master' });

  await assert.rejects(ctl.session(fakeReq(), { token: ana.token }), code('mfa_code_required'));
  const again = await ctl.session(fakeReq(), { token: ana.token, code: totpCode(secret, now() + 1) }) as { session: string; expires_at: Date };
  assert.ok(again.expires_at.getTime() - Date.now() <= 8 * 3600_000 + 5000, 'dura 8 horas');
  const { rows } = await ctx.pool.query('SELECT 1 FROM platform.operator_sessions WHERE token_hash = $1', [again.session]);
  assert.equal(rows.length, 0, 'en la base solo el hash de la sesión');

  await ctl.logout(fakeReq({ 'x-internal-token': again.session }));
  await assert.rejects(guard.canActivate(guardCtx(again.session).ctx), code('unauthenticated'));

  // Revocar a la persona cierra sus sesiones abiertas
  const anaOp = (await ops.authenticate(ana.token))!;
  const beto = await ops.create({ name: 'Beto', role: 'operator' }, anaOp);
  const betoSetup = await ctl.setup(fakeReq(), { token: beto.token });
  const betoSession = (await ctl.confirm(fakeReq(), { token: beto.token, code: totpCode(betoSetup.secret, now()) })).session;
  assert.equal(await guard.canActivate(guardCtx(betoSession).ctx), true);
  await ops.revoke(beto.id, anaOp);
  await assert.rejects(guard.canActivate(guardCtx(betoSession).ctx), code('unauthenticated'));
  const list = await ops.list();
  assert.equal(list.find((o) => o.name === 'Ana').mfa_enabled, true);
});

function selfSignedCert(): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '20', '-subj', '/CN=paguara-test',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
    return readFileSync(join(dir, 'c.pem'), 'utf8');
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('secretos de los bancos: cifrados por sobre, versionados, nunca en claro ni en el listado', async () => {
  const creds = new RailCredentialsService(ctx.pool);
  const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const v1 = await creds.put({ rail: 'ves_c2p', name: 'client_key', kind: 'private_key', value: pem }, 'platform:Ana');
  assert.equal(v1.version, 1);
  const { rows: [row] } = await ctx.pool.query('SELECT sealed FROM platform.rail_credentials WHERE id = $1', [v1.id]);
  assert.match(row.sealed, /^env:v1:/);
  assert.ok(!row.sealed.includes('PRIVATE KEY'));
  assert.equal(await creds.reveal('ves_c2p', 'client_key'), pem);
  assert.ok(!JSON.stringify(await creds.list()).includes('PRIVATE KEY'));

  const v2 = await creds.put({ rail: 'ves_c2p', name: 'client_key', kind: 'private_key', value: pem }, 'platform:Ana');
  assert.equal(v2.version, 2);
  assert.equal(v2.same_as_previous, true);
  assert.equal((await creds.list()).filter((c) => c.name === 'client_key').length, 1, 'la versión anterior queda retirada');

  await assert.rejects(creds.put({ rail: 'ves_c2p', name: 'k', kind: 'api_key', value: 'x' }, 'a'), code('name_invalid'));
  await assert.rejects(creds.put({ rail: 'ves_c2p', name: 'pk', kind: 'private_key', value: 'no-es-pem' }, 'a'), code('value_invalid'));
  await assert.rejects(creds.put({ rail: 'ves_c2p', name: 'cert', kind: 'certificate', value: 'no-es-pem' }, 'a'), code('value_invalid'));

  // La base rechaza un secreto en claro aunque la app tenga un bug
  assert.equal((await pgError(ctx.pool.query(
    `INSERT INTO platform.rail_credentials (id, rail, name, kind, version, sealed, fingerprint, created_by) VALUES ('rcred_x', 'ves_c2p', 'api', 'api_key', 1, 'clave', 'f', 'x')`))).code, '23514');

  // Sin KMS no se guarda
  setVaultForTests(new SecretVault(null));
  await assert.rejects(creds.put({ rail: 'ves_c2p', name: 'api_key', kind: 'api_key', value: 'abc' }, 'a'), code('kms_unavailable'));
  setVaultForTests(localVault(k1));

  const cert = selfSignedCert();
  if (cert) {
    const c = await creds.put({ rail: 'ves_c2p', name: 'client_cert', kind: 'certificate', value: cert }, 'platform:Ana');
    assert.ok(c.expires_at && c.expires_at.getTime() > Date.now());
    assert.deepEqual((await creds.expiringCertificates(30)).map((x) => x.name), ['client_cert']);
  }
});

test('rotación de la llave: rewrap vuelve a cifrar todo con la llave nueva y es idempotente', async () => {
  const hooks = new WebhooksService(ctx.pool);
  const m = await ctx.merchant('acct_rewrap');
  const ep = await hooks.createEndpoint(m, 'http://127.0.0.1:9/hook', ['*']);
  const creds = new RailCredentialsService(ctx.pool);
  await creds.put({ rail: 'zelle', name: 'api_key', kind: 'api_key', value: 'zelle-secreta' }, 'platform:Ana');

  setVaultForTests(localVault(k2, [k1]));
  const report = await rewrapAll(ctx.pool, vault());
  assert.ok(report['platform.rail_credentials.sealed'] >= 1);
  assert.ok(report['security.mfa_factors.secret_sealed'] >= 1);
  assert.equal(report['webhooks.endpoints.secret'], 1);
  assert.deepEqual(Object.values(await rewrapAll(ctx.pool, vault())).filter((n) => n > 0), [], 'la segunda corrida no cambia nada');

  // Con solo la llave nueva todo se sigue abriendo
  setVaultForTests(localVault(k2));
  assert.equal(await creds.reveal('zelle', 'api_key'), 'zelle-secreta');
  assert.equal((await hooks.revealSecret(m, ep.id)).secret, ep.secret);
});
