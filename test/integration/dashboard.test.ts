import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { AuthService, hashPassword, verifyPassword } from '../../src/dashboard/auth.service';
import { DashboardService } from '../../src/dashboard/dashboard.service';
import { enqueueEvent, isPrivateAddress, validateEndpointUrl, WebhooksService } from '../../src/webhooks/webhooks.service';
import { withTransaction } from '../../src/database/database';
import { Ctx, seedRates, setup } from './helpers';

let ctx: Ctx;
let redis: Redis;
let auth: AuthService;
let dash: DashboardService;
let hooks: WebhooksService;

before(async () => {
  process.env.WEBHOOK_ALLOW_HTTP = 'true';
  process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
  ctx = await setup();
  await seedRates(ctx.fx);
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  auth = new AuthService(ctx.pool, redis);
  dash = new DashboardService(ctx.pool, ctx.merchants, ctx.payments);
  hooks = new WebhooksService(ctx.pool);
});
after(async () => {
  redis.disconnect();
  await ctx.teardown();
  delete process.env.WEBHOOK_ALLOW_HTTP;
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
});

const fakeRes = () => { const h: Record<string, string> = {}; return { h, setHeader: (k: string, v: string) => { h[k] = v; } }; };

test('contraseñas con scrypt: verifica la correcta, rechaza otra, no guarda la clave', async () => {
  const h = await hashPassword('clave-larga-123');
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!h.includes('clave-larga-123'));
  assert.equal(await verifyPassword('clave-larga-123', h), true);
  assert.equal(await verifyPassword('clave-larga-124', h), false);
});

test('registro crea comercio con KYC pendiente y usuario; login abre sesión; logout la cierra', async () => {
  const email = `ana+${Date.now()}@ejemplo.com`;
  const { merchantId } = await auth.signup({ name: 'Ana', email: email.toUpperCase(), password: 'una-clave-segura', business_name: 'Arepera Ana', rif: 'j123456789' });
  const m = await ctx.merchants.get(merchantId);
  assert.equal(m.status, 'pending_kyc');
  assert.equal(m.rif, 'J-12345678-9');

  await assert.rejects(auth.signup({ name: 'Otra', email, password: 'una-clave-segura', business_name: 'Xy', rif: 'J-87654321-0' }),
    (e: { extra: { param: string } }) => e.extra.param === 'email');
  await assert.rejects(auth.signup({ name: 'Ana', email: 'b@x.co', password: 'corta', business_name: 'X', rif: 'J-87654321-0' }), /10 caracteres/);

  await assert.rejects(auth.login(email, 'otra-clave-mala', '10.0.0.1'), (e: { code: string }) => e.code === 'invalid_credentials');
  await assert.rejects(auth.login('nadie@ejemplo.com', 'una-clave-segura', '10.0.0.1'), (e: { code: string }) => e.code === 'invalid_credentials');
  const userId = await auth.login(email, 'una-clave-segura', '10.0.0.1');
  const res = fakeRes();
  const token = await auth.startSession(userId, res as never);
  assert.match(res.h['Set-Cookie'], /^sid=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax/);
  const stored = await ctx.pool.query('SELECT 1 FROM dashboard.sessions WHERE token_hash = $1', [token]);
  assert.equal(stored.rowCount, 0); // en la BD solo está el hash
  assert.equal((await auth.resolve(token))?.merchantId, merchantId);

  await auth.endSession({ header: () => `otra=1; sid=${token}` } as never, fakeRes() as never);
  assert.equal(await auth.resolve(token), null);
});

test('login: tras 10 fallos con el mismo correo responde 429 aunque la clave sea correcta', async () => {
  const email = `bloqueo+${Date.now()}@ejemplo.com`;
  await auth.signup({ name: 'Luis', email, password: 'una-clave-segura', business_name: 'Bodega', rif: 'J-22223333-4' });
  for (let i = 0; i < 10; i++) await assert.rejects(auth.login(email, 'mala-mala-mala', `10.1.0.${i}`));
  await assert.rejects(auth.login(email, 'una-clave-segura', '10.1.1.1'), (e: { code: string }) => e.code === 'too_many_attempts');
});

test('webhooks: el cobro deja eventos en el outbox y el worker los entrega firmados; reintenta si el comercio falla', async () => {
  const m = await ctx.merchant('acct_hooks');
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  let failNext = 1;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      if (failNext-- > 0) { res.statusCode = 500; res.end(); return; }
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
  try {
    const ep = await hooks.createEndpoint(m, url, ['payment_intent.succeeded']);
    assert.match(ep.secret, /^whsec_[a-f0-9]{48}$/);

    let pi = await ctx.payments.create(m, { amount: 1000n, currency: 'USD' });
    pi = await ctx.payments.attachPaymentMethod(m, pi.id, 'pago_movil_c2p');
    pi = await ctx.payments.confirm(m, pi.id, { phone: '04141234567', bank: '0102', otp: '123456' });
    assert.equal(pi.status, 'succeeded');

    const events = await hooks.listEvents(m, 10);
    assert.deepEqual(events.data.map((e) => e.type).sort(), ['payment_intent.created', 'payment_intent.succeeded']);
    const succeeded = events.data.find((e) => e.type === 'payment_intent.succeeded')!;
    assert.equal(succeeded.deliveries.length, 1); // solo el tipo suscrito genera entrega

    assert.equal(await hooks.deliverDue(), 1);   // primer intento: 500
    let ev = await hooks.getEvent(m, succeeded.id);
    assert.equal(ev.deliveries[0].status, 'pending');
    assert.equal(ev.deliveries[0].last_status_code, 500);
    assert.equal(await hooks.deliverDue(), 0);   // aún no toca reintentar
    await ctx.pool.query(`UPDATE webhooks.deliveries SET next_attempt_at = now() WHERE event_id = $1`, [succeeded.id]);
    assert.equal(await hooks.deliverDue(), 1);   // segundo intento: 200
    ev = await hooks.getEvent(m, succeeded.id);
    assert.equal(ev.deliveries[0].status, 'succeeded');
    assert.equal(ev.deliveries[0].attempts, 2);

    // Firma verificable con el secreto del endpoint, sin client_secret en el cuerpo
    const last = received[received.length - 1];
    const [t, v1] = String(last.headers['webhook-signature']).split(',').map((p) => p.split('=')[1]);
    assert.equal(v1, createHmac('sha256', ep.secret).update(`${t}.${last.body}`).digest('hex'));
    const payload = JSON.parse(last.body);
    assert.equal(payload.type, 'payment_intent.succeeded');
    assert.equal(payload.data.object.id, pi.id);
    assert.equal(payload.data.object.client_secret, undefined);
    assert.equal(last.headers['webhook-id'], succeeded.id);

    // Si la transacción del pago se revierte, su evento tampoco existe: el outbox va en la misma transacción
    const before = (await hooks.listEvents(m, 100)).data.length;
    await assert.rejects(withTransaction(ctx.pool, async (c) => {
      await enqueueEvent(c, { merchantId: m, livemode: false, type: 'payment_intent.succeeded', objectId: 'pi_x', object: {} });
      throw new Error('falla después de registrar el cobro');
    }));
    assert.equal((await hooks.listEvents(m, 100)).data.length, before);
  } finally {
    server.close();
  }
});

test('webhooks: no se aceptan destinos internos ni sin https en producción', () => {
  for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.16.3.4', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  delete process.env.WEBHOOK_ALLOW_HTTP;
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  try {
    assert.throws(() => validateEndpointUrl('http://comercio.com/h'), /https/);
    assert.throws(() => validateEndpointUrl('https://169.254.169.254/latest'), /pública/);
    assert.throws(() => validateEndpointUrl('https://localhost/h'), /pública/);
    assert.equal(validateEndpointUrl('https://comercio.com/h'), 'https://comercio.com/h');
  } finally {
    process.env.WEBHOOK_ALLOW_HTTP = 'true';
    process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
  }
});

test('dashboard: listado paginado y filtrado, saldos desde el ledger, links de pago crean pagos', async () => {
  const m = await ctx.merchant('acct_dash');
  for (let i = 0; i < 5; i++) {
    let pi = await ctx.payments.create(m, { amount: 1000n + BigInt(i), currency: 'USD', metadata: { description: `Pedido ${i}` } });
    if (i < 3) {
      pi = await ctx.payments.attachPaymentMethod(m, pi.id, 'pago_movil_c2p');
      await ctx.payments.confirm(m, pi.id, { phone: '04141234567', bank: '0102', otp: '1' });
    }
  }
  const page1 = await dash.listPayments(m, { limit: '2' });
  assert.equal(page1.data.length, 2);
  assert.equal(page1.has_more, true);
  const page2 = await dash.listPayments(m, { limit: '10', starting_after: page1.data[1].id });
  assert.equal(page2.data.length, 3);
  assert.equal(new Set([...page1.data, ...page2.data].map((p) => p.id)).size, 5);
  assert.equal((await dash.listPayments(m, { status: 'succeeded' })).data.length, 3);
  assert.equal((await dash.listPayments(m, { status: 'pending' })).data.length, 2);
  assert.equal((await dash.listPayments(m, { q: 'pedido 4' })).data.length, 1);
  assert.equal((await dash.listPayments(m, { q: '%' })).data.length, 0); // comodines escapados

  const ves = (await dash.balances(m)).find((b) => b.currency === 'VES')!;
  const nets = await ctx.pool.query<{ s: string }>(`SELECT sum(net_amount)::text AS s FROM payments.payment_intents WHERE merchant_id = $1 AND status = 'succeeded'`, [m]);
  assert.equal(ves.pending, nets.rows[0].s);
  assert.equal(ves.available, '0');

  const ov = await dash.overview(m);
  assert.equal(ov.today.count, 3);
  assert.equal(ov.recent.length, 5);

  const detail = await dash.paymentDetail(m, page1.data[0].id, 'https://pagos.ejemplo.com');
  assert.ok(detail.timeline.length >= 1);
  await assert.rejects(dash.paymentDetail('acct_otro', page1.data[0].id, ''), /No existe/);

  const link = (await dash.createLink(m, { amount: '1500', currency: 'USD', description: 'Torta tres leches' }, 'https://pagos.ejemplo.com'))!;
  assert.match(link.url, /^https:\/\/pagos\.ejemplo\.com\/pay\/[a-zA-Z0-9]{16}$/);
  const found = await dash.findActiveLink(link.url.split('/pay/')[1]);
  assert.equal(found?.id, link.id);
  const pi = await ctx.payments.create(m, { amount: BigInt(found!.amount), currency: found!.currency, paymentLinkId: found!.id });
  assert.equal(pi.payment_link_id, link.id);
  const url = await dash.checkoutUrl('', pi);
  assert.match(url, new RegExp(`^/checkout\\?pi=${pi.id}&cs=.+&pk=pk_test_[a-f0-9]{32}$`));
  assert.equal(await dash.checkoutUrl('', pi), url); // reutiliza la misma llave publicable
  await dash.setLinkActive(m, link.id, false, '');
  assert.equal(await dash.findActiveLink(link.url.split('/pay/')[1]), null);
  assert.equal((await dash.listLinks(m, ''))[0].payments_count, 1);
});
