/* Modo demostración del sitio: imita /api/dashboard/* con datos de ejemplo en memoria.
   Mismas formas JSON que docs/dashboard-api.md. Montos como string de enteros en unidades
   mínimas, calculados con bigint y redondeo bancario (half-even), igual que el servidor. */
(function () {
  'use strict';

  const DEMO_CHECKOUT_URL = 'https://claude.ai/artifact/U6WJAduU8biz6aZvrqEuDZ';
  const EXP = { VES: 2, USD: 2, USDT: 6 };
  const RATES = { 'USD/VES': '36.5', 'USDT/VES': '38.2', 'USDT/USD': '0.999' };
  const SOURCE = { 'USD/VES': 'BCV', 'USDT/VES': 'BINANCE_P2P', 'USDT/USD': 'EXCHANGE' };
  const CFG = {
    pago_movil_c2p: { cur: 'VES', bps: 150, fixed: 5n, tax: 1600, igtf: 0 },
    pago_movil_p2p: { cur: 'VES', bps: 150, fixed: 5n, tax: 1600, igtf: 0 },
    debito_inmediato: { cur: 'VES', bps: 150, fixed: 5n, tax: 1600, igtf: 0 },
    card_national: { cur: 'VES', bps: 380, fixed: 0n, tax: 1600, igtf: 0 },
    card_international: { cur: 'USD', bps: 490, fixed: 40n, tax: 0, igtf: 0 },
    zelle: { cur: 'USD', bps: 250, fixed: 25n, tax: 0, igtf: 0 },
    banesco_panama: { cur: 'USD', bps: 250, fixed: 25n, tax: 0, igtf: 0 },
    usdt_trc20: { cur: 'USDT', bps: 120, fixed: 10n, tax: 0, igtf: 0 },
    usdt_polygon: { cur: 'USDT', bps: 120, fixed: 10n, tax: 0, igtf: 0 },
    cash: { cur: 'USD', bps: 200, fixed: 25n, tax: 0, igtf: 300 },
  };
  const METHOD_NAMES = {
    pago_movil_c2p: 'Pago Móvil', pago_movil_p2p: 'Transferencia Pago Móvil', debito_inmediato: 'Débito inmediato',
    card_national: 'Tarjeta nacional', card_international: 'Tarjeta internacional', zelle: 'Zelle',
    banesco_panama: 'Banesco Panamá', usdt_trc20: 'USDT', usdt_polygon: 'USDT Polygon', cash: 'Efectivo en dólares',
  };
  const EVENT_TYPES = ['payment_intent.created', 'payment_intent.requires_action', 'payment_intent.succeeded',
    'payment_intent.payment_failed', 'payment_intent.canceled', 'payment_intent.settled', 'payout.created'];

  // ---------------------------------------------------------------------------
  // Aritmética exacta
  // ---------------------------------------------------------------------------
  const S = 10n ** 12n;
  const rateScaled = (r) => { const [i, f = ''] = r.split('.'); return BigInt(i) * S + BigInt((f + '0'.repeat(12)).slice(0, 12)); };
  const halfEven = (n, d) => { const q = n / d, r = n % d; return (r * 2n > d || (r * 2n === d && q % 2n === 1n)) ? q + 1n : q; };
  const bps = (a, b) => halfEven(a * BigInt(b), 10000n);
  function conv(amount, from, to) {
    if (from === to) return { amount, rate: null };
    const direct = RATES[from + '/' + to], inverse = RATES[to + '/' + from];
    const e = EXP[to] - EXP[from];
    if (direct) {
      let n = amount * rateScaled(direct), d = S;
      if (e >= 0) n *= 10n ** BigInt(e); else d *= 10n ** BigInt(-e);
      return { amount: halfEven(n, d), rate: direct, source: SOURCE[from + '/' + to] };
    }
    let n = amount * S, d = rateScaled(inverse);
    if (e >= 0) n *= 10n ** BigInt(e); else d *= 10n ** BigInt(-e);
    return { amount: halfEven(n, d), rate: inverse, source: SOURCE[to + '/' + from] };
  }
  function quote(price, currency, type) {
    const c = CFG[type];
    const q = conv(BigInt(price), currency, c.cur);
    const fixed = c.fixed === 0n || c.cur === 'USD' ? c.fixed : conv(c.fixed, 'USD', c.cur).amount;
    const fee = bps(q.amount, c.bps) + fixed, tax = bps(fee, c.tax), igtf = bps(q.amount, c.igtf);
    return {
      charge: { amount: String(q.amount + igtf), currency: c.cur, fee: String(fee), tax: String(tax), net: String(q.amount - fee - tax), igtf: String(igtf) },
      fx: q.rate ? { rate: q.rate, source: q.source } : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Datos sembrados (PRNG determinista para que las capturas sean estables)
  // ---------------------------------------------------------------------------
  let seed = 20261016;
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const hex = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(rnd() * 16)]; return s; };
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const DAY = 86400e3;

  const merchant = {
    id: 'acct_demo4f1c', business_name: 'Café El Ávila (ejemplo)', rif: 'J-40123456-7',
    status: 'pending_kyc', kyc_submitted_at: null, created: iso(now - 40 * DAY),
  };
  let user = { id: 'usr_demo91a2', name: 'María Fernández', email: 'maria@cafeelavila.example' };
  let loggedIn = true;

  const PRODUCTS = [
    ['Pedido #{n}: 1 kg de café de Caripe, molido', 'USD', [1800, 2500]],
    ['Pedido #{n}: 500 g de café en grano', 'USD', [950, 1200]],
    ['Pedido #{n}: caja de 12 cachitos', 'USD', [1400, 1600]],
    ['Suscripción mensual de café', 'USD', [3200, 3200]],
    ['Pedido #{n}: desayuno para la oficina', 'USD', [4500, 8800]],
    ['Mesa 4: consumo en el local', 'VES', [42000, 125000]],
    ['Pedido #{n}: torta tres leches', 'USD', [2200, 2800]],
    ['Taller de barismo, puesto', 'USD', [6000, 6000]],
  ];
  const CUSTOMERS = [
    ['Andrés Rodríguez', 'andres.r@correo.example'], ['Luisa Pérez', 'luisa.perez@correo.example'],
    ['Carlos Mendoza', null], ['Gabriela Suárez', 'gabys@correo.example'], ['José Hernández', null],
    ['Valentina Rojas', 'vale.rojas@correo.example'], ['Miguel Torres', 'mtorres@correo.example'], ['Daniela Castillo', null],
  ];
  const METHOD_POOL = ['pago_movil_c2p', 'pago_movil_c2p', 'pago_movil_c2p', 'pago_movil_p2p', 'pago_movil_p2p', 'debito_inmediato',
    'card_national', 'card_international', 'zelle', 'zelle', 'banesco_panama', 'usdt_trc20', 'usdt_trc20', 'usdt_polygon', 'cash'];

  const payments = [];
  const payouts = [];
  let orderNo = 1180;

  function nextAction(p) {
    const ch = p.charge;
    if (p.payment_method_type === 'pago_movil_p2p') return { type: 'pago_movil_transfer', bank: '0102', phone: '04140000000', rif: 'J-00000000-0', amount: ch.amount, currency: ch.currency, reference_hint: p.id.slice(-6) };
    if (p.payment_method_type === 'zelle') return { type: 'zelle_transfer', email: 'pagos@example.com', memo: p.id.slice(-8), amount: ch.amount, currency: ch.currency };
    if (p.payment_method_type === 'usdt_trc20' || p.payment_method_type === 'usdt_polygon') return { type: 'crypto_transfer', network: p.payment_method_type === 'usdt_trc20' ? 'TRON' : 'POLYGON', address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', amount: ch.amount, currency: ch.currency };
    if (p.payment_method_type === 'cash') return { type: 'cash_voucher', code: '7731 0425 9018', amount: ch.amount, currency: ch.currency };
    return null;
  }

  function makePayment(opts) {
    const created = opts.created;
    const id = 'pi_' + hex(14);
    const p = {
      id, status: 'requires_payment_method', amount: opts.amount, currency: opts.currency, description: opts.description || null,
      payment_method_type: null, charge: null, customer: opts.customer || null, created: iso(created), succeeded_at: null,
      fx: null, next_action: null, last_payment_error: null, metadata: opts.metadata || {},
      expires_at: iso(created + DAY), cancellation_reason: null, checkout_url: DEMO_CHECKOUT_URL,
      timeline: [{ from: null, to: 'requires_payment_method', event: 'create', actor: 'merchant:acct_demo4f1c', created: iso(created) }],
      payout: null,
    };
    payments.push(p);
    return p;
  }
  function step(p, to, event, actor, t) {
    p.timeline.push({ from: p.status, to, event, actor, created: iso(t) });
    p.status = to;
  }
  function attach(p, type, t) {
    const q = quote(p.amount, p.currency, type);
    p.payment_method_type = type;
    p.charge = q.charge;
    p.fx = q.fx ? { rate: q.fx.rate, source: q.fx.source, expires_at: iso(t + 15 * 60e3), frozen: false } : null;
    step(p, 'requires_confirmation', 'attach_payment_method', 'merchant:acct_demo4f1c', t);
  }

  function seedData() {
    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push('succeeded');
    // Mezcla fija de estados para cubrir todos los casos
    const plan = ['requires_action', 'requires_action', 'requires_action', 'requires_payment_method', 'requires_payment_method',
      'requires_confirmation', 'processing', 'canceled', 'canceled', 'canceled'];
    plan.forEach((s, i) => { statuses[i * 3 + 1] = s; });
    for (let i = 0; i < 40; i++) {
      const daysAgo = Math.floor(i * 14 / 40);
      const created = now - daysAgo * DAY - Math.floor(rnd() * 9 * 3600e3) - 20 * 60e3;
      const [desc, cur, range] = pick(PRODUCTS);
      const units = range[0] + Math.floor(rnd() * (range[1] - range[0] + 1) / 50) * 50;
      const amount = String(units * (cur === 'VES' ? 1 : 1));
      const c = pick(CUSTOMERS);
      const p = makePayment({
        created, amount, currency: cur, description: desc.replace('{n}', String(orderNo--)),
        customer: { name: c[0], email: c[1] }, metadata: { canal: pick(['web', 'whatsapp', 'instagram']) },
      });
      let s = statuses[i];
      let type = pick(METHOD_POOL);
      if (s === 'requires_action' && !['pago_movil_p2p', 'zelle', 'usdt_trc20'].includes(type)) type = ['pago_movil_p2p', 'zelle', 'usdt_trc20'][i % 3];
      if (s === 'requires_payment_method') { if (i % 2) p.customer = null; continue; }
      const t1 = created + 60e3 * (1 + Math.floor(rnd() * 6));
      attach(p, type, t1);
      if (s === 'requires_confirmation') continue;
      if (s === 'canceled') {
        p.status = 'requires_action'; // primero esperó al pagador
        p.timeline.push({ from: 'requires_confirmation', to: 'requires_action', event: 'confirm', actor: 'merchant:acct_demo4f1c', created: iso(t1 + 30e3) });
        step(p, 'canceled', 'cancel', 'merchant:acct_demo4f1c', t1 + 3 * 3600e3);
        p.cancellation_reason = 'requested_by_merchant';
        continue;
      }
      if (p.fx) p.fx.frozen = true;
      const t2 = t1 + 45e3;
      const na = nextAction(p);
      if (na) {
        step(p, 'requires_action', 'require_action', 'rail:' + p.payment_method_type, t2);
        if (s === 'requires_action') { p.next_action = na; continue; }
        step(p, 'processing', 'action_completed', 'worker:conciliacion', t2 + 4 * 60e3);
      } else {
        step(p, 'processing', 'confirm', 'merchant:acct_demo4f1c', t2);
      }
      if (s === 'processing') continue;
      const t3 = t2 + (na ? 5 * 60e3 : 4e3);
      step(p, 'succeeded', 'rail_succeeded', 'rail:' + p.payment_method_type, t3);
      p.succeeded_at = iso(t3);
    }
    payments.sort((a, b) => (a.created < b.created ? 1 : -1));
    makePayouts();
  }

  // Lotes VES ya liquidados: 60 % en Bs, 40 % convertido a USDT con spread de 1,2 %
  function makePayouts() {
    const ves = payments.filter((p) => p.status === 'succeeded' && p.charge.currency === 'VES' && Date.parse(p.created) < now - 3 * DAY)
      .sort((a, b) => (a.created < b.created ? -1 : 1));
    const groups = [[], [], []];
    ves.forEach((p, i) => groups[Math.min(2, Math.floor(i * 3 / ves.length))].push(p));
    groups.forEach((g, gi) => {
      if (!g.length) return;
      const last = Date.parse(g[g.length - 1].succeeded_at);
      const created = Math.min(now - (3 - gi) * DAY, last + DAY);
      const d = new Date(created);
      const batch = 'LQ-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + String(gi + 1).padStart(3, '0');
      const id = 'po_' + hex(12);
      let total = 0n;
      g.forEach((p) => {
        total += BigInt(p.charge.net);
        step(p, 'settled', 'settle', 'settlement', created);
        p.payout = { id, batch_code: batch, created: iso(created) };
      });
      const usdtPart = bps(total, 4000);
      const spread = bps(usdtPart, 120);
      const usdt = conv(usdtPart - spread, 'VES', 'USDT').amount;
      payouts.push({
        id, batch_code: batch, source_currency: 'VES', source_amount: String(total), created: iso(created),
        instructions: [
          { currency: 'VES', amount: String(total - usdtPart), fx_rate: null, fx_spread_bps: 0, destination: { type: 'bank_ves', bank: '0134', holder: 'Café El Ávila (ejemplo)', account: '01340000000000001234' }, status: gi === 2 ? 'pending' : 'paid' },
          { currency: 'USDT', amount: String(usdt), fx_rate: RATES['USDT/VES'], fx_spread_bps: 120, destination: { type: 'usdt_trc20', address: 'TXk3cVzr8m5Kq2hAvYJp7WnDq9sLtE4uRb' }, status: gi === 2 ? 'pending' : 'paid' },
        ],
      });
    });
    payouts.sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  seedData();

  let rules = {
    VES: [
      { target_currency: 'VES', bps: 6000, destination: { type: 'bank_ves', bank: '0134', holder: 'Café El Ávila (ejemplo)', account: '01340000000000001234' } },
      { target_currency: 'USDT', bps: 4000, destination: { type: 'usdt_trc20', address: 'TXk3cVzr8m5Kq2hAvYJp7WnDq9sLtE4uRb' } },
    ],
    USD: [{ target_currency: 'USD', bps: 10000, destination: { type: 'bank_usd', bank: 'Banesco Panamá', holder: 'Café El Ávila (ejemplo)', account: '201800012345' } }],
    USDT: [{ target_currency: 'USDT', bps: 10000, destination: { type: 'usdt_trc20', address: 'TXk3cVzr8m5Kq2hAvYJp7WnDq9sLtE4uRb' } }],
  };

  const keys = [
    { id: 'key_' + hex(10), kind: 'publishable', livemode: false, prefix: 'pk_test_51Qd', key: 'pk_test_51QdAvila' + hex(16), active: true, last_used_at: iso(now - 2 * 3600e3), created: iso(now - 40 * DAY), revoked_at: null },
    { id: 'key_' + hex(10), kind: 'secret', livemode: false, prefix: 'sk_test_51Qd', key: null, active: true, last_used_at: iso(now - 25 * 60e3), created: iso(now - 40 * DAY), revoked_at: null },
    { id: 'key_' + hex(10), kind: 'secret', livemode: false, prefix: 'sk_test_8Rnm', key: null, active: false, last_used_at: iso(now - 30 * DAY), created: iso(now - 39 * DAY), revoked_at: iso(now - 30 * DAY) },
  ];

  const endpoints = [{
    id: 'we_' + hex(12), url: 'https://cafeelavila.example/webhooks/pagos',
    enabled_events: ['payment_intent.succeeded', 'payment_intent.canceled', 'payment_intent.settled', 'payout.created'],
    status: 'enabled', created: iso(now - 38 * DAY), last_delivery: null, _secret: 'whsec_' + hex(32),
  }];

  const events = [];
  function addEvent(type, obj, t, failed) {
    const ep = endpoints.filter((e) => e.status === 'enabled' && e.enabled_events.includes(type));
    const ev = {
      id: 'evt_' + hex(14), type, created: iso(t), object_id: obj.id,
      deliveries: ep.map((e) => failed
        ? { endpoint_id: e.id, url: e.url, status: 'failed', attempts: 3, last_status_code: 500, next_attempt_at: iso(t + 40 * 60e3) }
        : { endpoint_id: e.id, url: e.url, status: 'succeeded', attempts: 1, last_status_code: 200, next_attempt_at: null }),
      _payload: { id: null, type, created: Math.floor(t / 1000), livemode: false, data: { object: summary(obj) } },
    };
    ev._payload.id = ev.id;
    events.push(ev);
    ep.forEach((e) => { e.last_delivery = { status: failed ? 'failed' : 'succeeded', at: iso(t), status_code: failed ? 500 : 200 }; });
    return ev;
  }
  (function seedEvents() {
    const recent = payments.slice(0, 16).reverse();
    recent.forEach((p, i) => {
      addEvent('payment_intent.created', p, Date.parse(p.created));
      if (p.status === 'requires_action') addEvent('payment_intent.requires_action', p, Date.parse(p.created) + 2 * 60e3);
      if (p.succeeded_at) addEvent('payment_intent.succeeded', p, Date.parse(p.succeeded_at), i === 9);
      if (p.status === 'canceled') addEvent('payment_intent.canceled', p, Date.parse(p.timeline[p.timeline.length - 1].created));
    });
    payouts.slice(0, 1).forEach((po) => addEvent('payout.created', po, Date.parse(po.created)));
    events.sort((a, b) => (a.created < b.created ? 1 : -1));
  })();

  const links = [
    { id: 'plink_' + hex(10), url: DEMO_CHECKOUT_URL, amount: '2500', currency: 'USD', description: '1 kg de café de Caripe, molido', active: true, created: iso(now - 20 * DAY), payments_count: 14, succeeded_count: 11 },
    { id: 'plink_' + hex(10), url: DEMO_CHECKOUT_URL, amount: '3200', currency: 'USD', description: 'Suscripción mensual de café', active: true, created: iso(now - 12 * DAY), payments_count: 6, succeeded_count: 6 },
    { id: 'plink_' + hex(10), url: DEMO_CHECKOUT_URL, amount: '6000', currency: 'USD', description: 'Taller de barismo, puesto', active: false, created: iso(now - 33 * DAY), payments_count: 9, succeeded_count: 7 },
  ];

  // ---------------------------------------------------------------------------
  // Proyecciones
  // ---------------------------------------------------------------------------
  function summary(p) {
    if (!p.status) return JSON.parse(JSON.stringify(p));
    const { id, status, amount, currency, description, payment_method_type, charge, customer, created, succeeded_at } = p;
    return JSON.parse(JSON.stringify({ id, status, amount, currency, description, payment_method_type, charge, customer, created, succeeded_at }));
  }
  function detail(p) {
    const d = JSON.parse(JSON.stringify(p));
    return d;
  }
  function balances() {
    const out = {};
    ['VES', 'USD', 'USDT'].forEach((c) => { out[c] = { currency: c, pending: 0n, available: 0n }; });
    payments.forEach((p) => {
      if (p.status !== 'succeeded') return;
      const b = out[p.charge.currency];
      if (Date.parse(p.succeeded_at) > now - 1.5 * DAY) b.pending += BigInt(p.charge.net); else b.available += BigInt(p.charge.net);
    });
    return Object.values(out).map((b) => ({ currency: b.currency, pending: String(b.pending), available: String(b.available) }));
  }
  const ok = (p) => p.status === 'succeeded' || p.status === 'settled';
  const isPending = (p) => p.status.startsWith('requires_') || p.status === 'processing';
  function overview() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = payments.filter((p) => ok(p) && Date.parse(p.succeeded_at) >= start.getTime());
    const vol = {};
    today.forEach((p) => { vol[p.charge.currency] = (vol[p.charge.currency] || 0n) + BigInt(p.charge.amount); });
    const series = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(start.getTime() - i * DAY);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      ['VES', 'USD', 'USDT'].forEach((c) => {
        const ps = payments.filter((p) => ok(p) && p.charge.currency === c && Date.parse(p.succeeded_at) >= d.getTime() && Date.parse(p.succeeded_at) < d.getTime() + DAY);
        series.push({ date: key, currency: c, amount: String(ps.reduce((s, p) => s + BigInt(p.charge.amount), 0n)), count: ps.length });
      });
    }
    return {
      balances: balances(),
      today: { count: today.length, volume: Object.entries(vol).map(([currency, amount]) => ({ currency, amount: String(amount) })) },
      series,
      recent: payments.slice(0, 6).map(summary),
      needs_action: payments.filter((p) => p.status === 'requires_action').length,
    };
  }
  function session() {
    return { user: Object.assign({}, user), merchant: Object.assign({}, merchant), livemode: false, other_mode_url: null, event_types: EVENT_TYPES.slice() };
  }

  // ---------------------------------------------------------------------------
  // Router de la API simulada
  // ---------------------------------------------------------------------------
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  const fail = (status, code, message) => { throw new ApiError(status, code, message); };
  const need = () => { if (!loggedIn) fail(401, 'unauthenticated', 'Tu sesión venció. Vuelve a entrar.'); };
  const find = (list, id) => list.find((x) => x.id === id) || fail(404, 'resource_missing', 'No encontramos ese recurso.');
  const amountOk = (a) => typeof a === 'string' && /^[1-9]\d{0,15}$/.test(a);

  const routes = [
    ['POST', /^\/signup$/, (m, b) => {
      if (!b || !b.email || !b.password || String(b.password).length < 10) fail(422, 'validation_error', 'Revisa los datos del formulario.');
      if (!/^[JGVEP]-?\d{8}-?\d$/i.test(b.rif || '')) fail(422, 'rif_invalid', 'El RIF no tiene un formato válido.');
      user = { id: 'usr_' + hex(8), name: b.name, email: b.email };
      Object.assign(merchant, { business_name: b.business_name, rif: b.rif.toUpperCase(), status: 'pending_kyc', kyc_submitted_at: null });
      loggedIn = true;
      return session();
    }],
    ['POST', /^\/login$/, (m, b) => {
      if (!b || !b.email || !b.password) fail(401, 'invalid_credentials', 'El correo o la contraseña no coinciden.');
      loggedIn = true;
      user.email = b.email;
      return session();
    }],
    ['POST', /^\/logout$/, () => { loggedIn = false; return { ok: true }; }],
    ['GET', /^\/me$/, () => { need(); return session(); }],
    ['PUT', /^\/account$/, (m, b) => {
      need();
      if (!b.business_name || !String(b.business_name).trim()) fail(422, 'validation_error', 'Escribe el nombre del negocio.');
      merchant.business_name = String(b.business_name).trim();
      return Object.assign({}, merchant);
    }],
    ['POST', /^\/account\/kyc$/, (m, b) => {
      need();
      const req = ['legal_name', 'representative_name', 'representative_id', 'address', 'phone', 'bank_name', 'bank_account'];
      if (req.some((k) => !b[k])) fail(422, 'validation_error', 'Completa todos los datos de la empresa.');
      merchant.kyc_submitted_at = new Date().toISOString();
      return Object.assign({}, merchant);
    }],
    ['GET', /^\/overview$/, () => { need(); return overview(); }],
    ['GET', /^\/payments$/, (m, b, q) => {
      need();
      const st = q.status || 'all';
      const text = (q.q || '').trim().toLowerCase();
      let list = payments.filter((p) => st === 'all' || (st === 'succeeded' && ok(p)) || (st === 'pending' && isPending(p)) || (st === 'canceled' && p.status === 'canceled'));
      if (text) list = list.filter((p) => p.id.toLowerCase().includes(text) || (p.description || '').toLowerCase().includes(text));
      let start = 0;
      if (q.starting_after) start = list.findIndex((p) => p.id === q.starting_after) + 1;
      const limit = Math.min(100, Number(q.limit) || 25);
      const page = list.slice(start, start + limit);
      return { data: page.map(summary), has_more: start + limit < list.length };
    }],
    ['POST', /^\/payments$/, (m, b) => {
      need();
      if (!amountOk(b.amount)) fail(422, 'amount_invalid', 'El monto debe ser mayor que cero.');
      if (!EXP[b.currency]) fail(422, 'currency_invalid', 'Moneda no soportada.');
      const p = makePayment({ created: Date.now(), amount: b.amount, currency: b.currency, description: b.description || null, actor: 'dashboard' });
      payments.sort((a, c) => (a.created < c.created ? 1 : -1));
      addEvent('payment_intent.created', p, Date.now()); events.sort((a, c) => (a.created < c.created ? 1 : -1));
      return { payment: detail(p), checkout_url: DEMO_CHECKOUT_URL };
    }],
    ['GET', /^\/payments\/([\w]+)$/, (m) => { need(); return detail(find(payments, m[1])); }],
    ['POST', /^\/payments\/([\w]+)\/cancel$/, (m) => {
      need();
      const p = find(payments, m[1]);
      if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(p.status)) fail(409, 'payment_intent_unexpected_state', 'Este pago ya no se puede cancelar.');
      step(p, 'canceled', 'cancel', 'merchant:acct_demo4f1c', Date.now());
      p.cancellation_reason = 'requested_by_merchant';
      p.next_action = null;
      addEvent('payment_intent.canceled', p, Date.now()); events.sort((a, c) => (a.created < c.created ? 1 : -1));
      return detail(p);
    }],
    ['GET', /^\/balances$/, () => { need(); return { balances: balances(), payouts: JSON.parse(JSON.stringify(payouts)) }; }],
    ['GET', /^\/settlement_rules$/, () => { need(); return { rules: JSON.parse(JSON.stringify(rules)) }; }],
    ['PUT', /^\/settlement_rules\/(VES|USD|USDT)$/, (m, b) => {
      need();
      const list = (b && b.rules) || [];
      const sum = list.reduce((s, r) => s + Number(r.bps || 0), 0);
      if (!list.length || sum !== 10000) fail(422, 'settlement_rules_invalid', 'Los porcentajes deben sumar 100 %.');
      rules[m[1]] = JSON.parse(JSON.stringify(list));
      return { rules: JSON.parse(JSON.stringify(rules)) };
    }],
    ['GET', /^\/payment_links$/, () => { need(); return { data: JSON.parse(JSON.stringify(links)) }; }],
    ['POST', /^\/payment_links$/, (m, b) => {
      need();
      if (!amountOk(b.amount)) fail(422, 'amount_invalid', 'El monto debe ser mayor que cero.');
      const l = { id: 'plink_' + hex(10), url: DEMO_CHECKOUT_URL, amount: b.amount, currency: b.currency, description: b.description || '', active: true, created: new Date().toISOString(), payments_count: 0, succeeded_count: 0 };
      links.unshift(l);
      return Object.assign({}, l);
    }],
    ['POST', /^\/payment_links\/([\w]+)\/(activate|deactivate)$/, (m) => {
      need();
      const l = find(links, m[1]);
      l.active = m[2] === 'activate';
      return Object.assign({}, l);
    }],
    ['GET', /^\/api_keys$/, () => { need(); return { data: JSON.parse(JSON.stringify(keys)) }; }],
    ['POST', /^\/api_keys$/, (m, b) => {
      need();
      const kind = b.kind === 'publishable' ? 'publishable' : 'secret';
      const key = (kind === 'secret' ? 'sk_test_' : 'pk_test_') + hex(24);
      const k = { id: 'key_' + hex(10), kind, livemode: false, prefix: key.slice(0, 12), key: kind === 'publishable' ? key : null, active: true, last_used_at: null, created: new Date().toISOString(), revoked_at: null };
      keys.unshift(k);
      return { id: k.id, key };
    }],
    ['POST', /^\/api_keys\/([\w]+)\/roll$/, (m) => {
      need();
      const old = find(keys, m[1]);
      if (!old.active) fail(409, 'api_key_revoked', 'Esta llave ya fue revocada.');
      old.active = false; old.revoked_at = new Date().toISOString();
      const key = (old.kind === 'secret' ? 'sk_test_' : 'pk_test_') + hex(24);
      const k = { id: 'key_' + hex(10), kind: old.kind, livemode: false, prefix: key.slice(0, 12), key: old.kind === 'publishable' ? key : null, active: true, last_used_at: null, created: new Date().toISOString(), revoked_at: null };
      keys.unshift(k);
      return { id: k.id, key };
    }],
    ['POST', /^\/api_keys\/([\w]+)\/revoke$/, (m) => {
      need();
      const k = find(keys, m[1]);
      k.active = false; k.revoked_at = new Date().toISOString();
      return { ok: true };
    }],
    ['GET', /^\/webhooks$/, () => { need(); return { data: endpoints.map(pubEndpoint) }; }],
    ['POST', /^\/webhooks$/, (m, b) => {
      need();
      if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(b.url || '')) fail(422, 'url_invalid', 'La URL debe empezar con https:// y ser pública.');
      if (!b.enabled_events || !b.enabled_events.length) fail(422, 'events_required', 'Elige al menos un tipo de evento.');
      const e = { id: 'we_' + hex(12), url: b.url, enabled_events: b.enabled_events.slice(), status: 'enabled', created: new Date().toISOString(), last_delivery: null, _secret: 'whsec_' + hex(32) };
      endpoints.push(e);
      return Object.assign(pubEndpoint(e), { secret: e._secret });
    }],
    ['POST', /^\/webhooks\/([\w]+)\/reveal$/, (m) => { need(); return { secret: find(endpoints, m[1])._secret }; }],
    ['POST', /^\/webhooks\/([\w]+)\/(enable|disable)$/, (m) => {
      need();
      const e = find(endpoints, m[1]);
      e.status = m[2] === 'enable' ? 'enabled' : 'disabled';
      return pubEndpoint(e);
    }],
    ['POST', /^\/webhooks\/([\w]+)\/test$/, (m) => {
      need();
      const e = find(endpoints, m[1]);
      const ev = { id: 'evt_' + hex(14), type: 'payment_intent.succeeded', created: new Date().toISOString(), object_id: payments[0].id,
        deliveries: [{ endpoint_id: e.id, url: e.url, status: 'succeeded', attempts: 1, last_status_code: 200, next_attempt_at: null }],
        _payload: { id: null, type: 'payment_intent.succeeded', created: Math.floor(Date.now() / 1000), livemode: false, test: true, data: { object: summary(payments[0]) } } };
      ev._payload.id = ev.id;
      events.unshift(ev);
      e.last_delivery = { status: 'succeeded', at: ev.created, status_code: 200 };
      return { event_id: ev.id };
    }],
    ['GET', /^\/events$/, (m, b, q) => {
      need();
      let start = 0;
      if (q.starting_after) start = events.findIndex((e) => e.id === q.starting_after) + 1;
      const limit = Math.min(100, Number(q.limit) || 20);
      return { data: events.slice(start, start + limit).map(pubEvent), has_more: start + limit < events.length };
    }],
    ['GET', /^\/events\/([\w]+)$/, (m) => { need(); const e = find(events, m[1]); return Object.assign(pubEvent(e), { payload: JSON.parse(JSON.stringify(e._payload)) }); }],
    ['POST', /^\/events\/([\w]+)\/resend$/, (m) => {
      need();
      const e = find(events, m[1]);
      e.deliveries.forEach((d) => { d.status = 'succeeded'; d.attempts += 1; d.last_status_code = 200; d.next_attempt_at = null; });
      return { ok: true };
    }],
    ['GET', /^\/api\/public\/methods$/, () => Object.entries(CFG).map(([type, c]) => ({ type, name: METHOD_NAMES[type], currency: c.cur, fee_bps: c.bps, fixed_usd: String(c.fixed), tax_bps: c.tax, igtf_bps: c.igtf }))],
  ];
  function pubEndpoint(e) { const o = Object.assign({}, e); delete o._secret; return JSON.parse(JSON.stringify(o)); }
  function pubEvent(e) { const o = Object.assign({}, e); delete o._payload; return JSON.parse(JSON.stringify(o)); }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function request(method, path, body, params) {
    await wait(180 + Math.floor(Math.random() * 220));
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const match = re.exec(path);
      if (match) return JSON.parse(JSON.stringify(fn(match, body || {}, params || {})));
    }
    throw new ApiError(404, 'resource_missing', 'Ruta no encontrada en el modo de demostración.');
  }

  window.DemoApi = {
    request,
    get: (path, params) => request('GET', path, null, params),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
  };
})();
