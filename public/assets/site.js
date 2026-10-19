/* Sitio público, registro, panel del comercio y documentación.
   SPA con rutas en el hash (#/...), así funciona igual servida por la API o como página estática.
   Con window.__SERVER__ === true habla con /api/dashboard; si no, usa window.DemoApi (site-demo.js).
   Nunca se usa innerHTML con datos: todo se construye con createElement/textContent. */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Marca: nombre provisional, se cambia solo aquí
  // ---------------------------------------------------------------------------
  const BRAND = { name: 'Paguara' };

  const IS_SERVER = window.__SERVER__ === true;
  const API_BASE = IS_SERVER ? location.origin : 'https://api.' + BRAND.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '') + '.example';

  // ---------------------------------------------------------------------------
  // Catálogos
  // ---------------------------------------------------------------------------
  const EXP = { VES: 2, USD: 2, EUR: 2, USDT: 6 };
  const SYMBOL = { VES: 'Bs', USD: 'USD', EUR: 'EUR', USDT: 'USDT' };
  const CUR_LONG = { VES: 'bolívares', USD: 'dólares', USDT: 'USDT' };
  const METHOD_NAMES = {
    pago_movil_c2p: 'Pago Móvil', pago_movil_p2p: 'Transferencia Pago Móvil', debito_inmediato: 'Débito inmediato',
    card_national: 'Tarjeta nacional', card_international: 'Tarjeta internacional', zelle: 'Zelle',
    banesco_panama: 'Banesco Panamá', usdt_trc20: 'USDT', usdt_polygon: 'USDT Polygon', cash: 'Efectivo en dólares',
  };
  // Precios: espejo de src/payment-intents/payment-methods.ts (en el servidor se actualizan con /api/public/methods)
  const PRICING = [
    { type: 'pago_movil_c2p', name: 'Pago Móvil C2P', cur: 'VES', bps: 150, fixed: '5', tax: 1600, igtf: 0 },
    { type: 'pago_movil_p2p', name: 'Pago Móvil P2P (transferencia)', cur: 'VES', bps: 150, fixed: '5', tax: 1600, igtf: 0 },
    { type: 'debito_inmediato', name: 'Débito inmediato', cur: 'VES', bps: 150, fixed: '5', tax: 1600, igtf: 0 },
    { type: 'card_national', name: 'Tarjeta nacional', cur: 'VES', bps: 380, fixed: '0', tax: 1600, igtf: 0 },
    { type: 'card_international', name: 'Tarjeta internacional', cur: 'USD', bps: 490, fixed: '40', tax: 0, igtf: 0 },
    { type: 'zelle', name: 'Zelle', cur: 'USD', bps: 250, fixed: '25', tax: 0, igtf: 0 },
    { type: 'banesco_panama', name: 'Banesco Panamá', cur: 'USD', bps: 250, fixed: '25', tax: 0, igtf: 0 },
    { type: 'usdt_trc20', name: 'USDT (TRC-20)', cur: 'USDT', bps: 120, fixed: '10', tax: 0, igtf: 0 },
    { type: 'usdt_polygon', name: 'USDT (Polygon)', cur: 'USDT', bps: 120, fixed: '10', tax: 0, igtf: 0 },
    { type: 'cash', name: 'Efectivo en dólares', cur: 'USD', bps: 200, fixed: '25', tax: 0, igtf: 300 },
  ];
  const STATUS = {
    requires_payment_method: ['Sin método', 'note'],
    requires_confirmation: ['Por confirmar', 'note'],
    requires_action: ['Esperando al cliente', 'warn'],
    processing: ['Procesando', 'note'],
    succeeded: ['Exitoso', 'ok'],
    settled: ['Liquidado', 'accent'],
    canceled: ['Cancelado', ''],
  };
  const CANCELABLE = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
  // Eventos del historial (nombres de transición del servidor; se aceptan también los alias antiguos)
  const TL_EVENTS = {
    create: 'Pago creado', created: 'Pago creado', attach_payment_method: 'Se eligió el método de pago', payment_method_attached: 'Se eligió el método de pago',
    confirm: 'El cliente confirmó', confirmed: 'El cliente confirmó', require_action: 'Esperando la acción del cliente',
    action_completed: 'Detectamos la transferencia', transfer_detected: 'Detectamos la transferencia',
    rail_succeeded: 'El banco aprobó el pago', rail_failed: 'El banco rechazó el pago', funds_received: 'Fondos recibidos del banco',
    settle: 'Incluido en una liquidación', settled: 'Incluido en una liquidación', cancel: 'Pago cancelado', canceled: 'Pago cancelado',
    expired: 'El pago venció',
  };
  function actorName(a) {
    const k = String(a || '').split(':')[0];
    return { merchant: 'Tu cuenta', api: 'API', dashboard: 'Panel', checkout: 'Checkout', rail: 'Banco o red', worker: 'Conciliación', settlement: 'Liquidación', system: 'Sistema' }[k] || k;
  }
  const RATE_NAMES = { BCV: 'Tasa BCV', BINANCE_P2P: 'Tasa USDT (Binance P2P)', EXCHANGE: 'Tasa del exchange', PARALLEL: 'Tasa' };
  const EVENT_INFO = {
    'payment_intent.created': 'Se creó un pago.',
    'payment_intent.requires_action': 'El cliente debe transferir, enviar USDT o pagar en taquilla.',
    'payment_intent.succeeded': 'El pago se cobró. Entrega el pedido.',
    'payment_intent.payment_failed': 'El banco rechazó el intento. El cliente puede reintentar.',
    'payment_intent.canceled': 'El pago se canceló o venció.',
    'payment_intent.settled': 'El pago entró en una liquidación.',
    'payout.created': 'Se generó un lote de liquidación.',
  };
  const BANKS = [
    ['0102', 'Banco de Venezuela'], ['0105', 'Mercantil'], ['0108', 'BBVA Provincial'], ['0134', 'Banesco'],
    ['0191', 'BNC'], ['0172', 'Bancamiga'], ['0114', 'Bancaribe'], ['0151', 'BFC'], ['0174', 'Banplus'],
    ['0163', 'Banco del Tesoro'], ['0175', 'Banco Digital de los Trabajadores'], ['0104', 'Venezolano de Crédito'],
  ];
  const ERRORS = {
    insufficient_funds: 'El banco rechazó el pago por fondos insuficientes.',
    invalid_c2p_token: 'La clave de pago C2P no es válida o ya venció.',
    do_not_honor: 'El banco no autorizó el pago.',
    card_declined: 'La tarjeta fue rechazada.',
    action_expired: 'No recibimos la transferencia a tiempo.',
    bank_unavailable: 'El banco no estaba respondiendo.',
    fx_quote_expired: 'La tasa venció antes de confirmar.',
    payment_intent_expired: 'El pago venció.',
    resource_missing: 'No encontramos ese recurso.',
  };

  // ---------------------------------------------------------------------------
  // Formato venezolano sobre strings (3.650,00): los montos nunca pasan por float
  // ---------------------------------------------------------------------------
  function fmt(minor, cur, opts) {
    const exp = EXP[cur] == null ? 2 : EXP[cur];
    let s = String(minor == null ? '0' : minor);
    const neg = s.startsWith('-');
    if (neg) s = s.slice(1);
    s = s.replace(/^0+(?=\d)/, '').padStart(exp + 1, '0');
    let int = s.slice(0, s.length - exp), frac = s.slice(s.length - exp);
    if (cur === 'USDT') frac = frac.replace(/0+$/, '').padEnd(2, '0');
    int = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const num = (neg ? '−' : '') + (frac ? int + ',' + frac : int);
    return opts && opts.bare ? num : (SYMBOL[cur] || cur) + ' ' + num;
  }
  function fmtRate(rate) {
    const [i, f = ''] = String(rate).split('.');
    return i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + f.replace(/0+$/, '').padEnd(2, '0');
  }
  function pct(bps) {
    const n = Number(bps) || 0;
    const i = Math.floor(n / 100), f = n % 100;
    return (f ? i + ',' + String(f).padStart(2, '0').replace(/0$/, '') : String(i)) + ' %';
  }
  // "1.250,50" / "1250.5" / "25" → unidades mínimas como string, o null
  function parseAmount(raw, cur) {
    let s = String(raw || '').trim().replace(/\s/g, '').replace(/^(bs\.?|usdt|usd|\$)/i, '');
    if (!s) return null;
    const exp = EXP[cur];
    let int, frac = '';
    if (s.includes(',')) {
      const p = s.split(',');
      if (p.length > 2) return null;
      if (p[0].includes('.') && !/^\d{1,3}(\.\d{3})+$/.test(p[0])) return null;
      int = p[0].replace(/\./g, ''); frac = p[1];
    } else if (s.includes('.')) {
      const p = s.split('.');
      if (p.length === 2 && p[1].length !== 3) { int = p[0]; frac = p[1]; }
      else { if (!/^\d{1,3}(\.\d{3})+$/.test(s)) return null; int = p.join(''); }
    } else int = s;
    if (!/^\d*$/.test(int) || !/^\d*$/.test(frac) || frac.length > exp || (!int && !frac)) return null;
    const minor = ((int || '0') + frac.padEnd(exp, '0')).replace(/^0+(?=\d)/, '');
    return /^0+$/.test(minor) ? null : minor;
  }
  // "60" / "33,5" → bps (número entero) o null
  function parseBps(raw) {
    const s = String(raw || '').trim().replace('.', ',');
    if (!/^\d{1,3}(,\d{1,2})?$/.test(s)) return null;
    const [i, f = ''] = s.split(',');
    return Number(i) * 100 + Number(f.padEnd(2, '0'));
  }
  function rateText(pi) {
    const from = pi.currency, to = pi.charge.currency;
    const price = Number(pi.amount) / 10 ** EXP[from];
    const got = (Number(pi.charge.amount) - Number(pi.charge.igtf || 0)) / 10 ** EXP[to];
    const r = Number(pi.fx.rate);
    const mult = Math.abs(price * r - got) <= Math.abs(price / r - got);
    return mult ? '1 ' + SYMBOL[from] + ' = ' + fmtRate(pi.fx.rate) + ' ' + SYMBOL[to] : '1 ' + SYMBOL[to] + ' = ' + fmtRate(pi.fx.rate) + ' ' + SYMBOL[from];
  }
  const DATE = new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short', year: 'numeric' });
  const DATE_NY = new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short' });
  const DATETIME = new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const DT_NY = new Intl.DateTimeFormat('es-VE', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const TIME = new Intl.DateTimeFormat('es-VE', { hour: 'numeric', minute: '2-digit' });
  function fmtWhen(iso, withTime) {
    if (!iso) return '';
    const d = new Date(iso);
    const t = new Date();
    if (withTime !== false && d.toDateString() === t.toDateString()) return 'Hoy, ' + TIME.format(d);
    const same = d.getFullYear() === t.getFullYear();
    if (withTime === false) return (same ? DATE_NY : DATE).format(d);
    return (same ? DT_NY : DATETIME).format(d);
  }
  const fmtFull = (iso) => (iso ? DATETIME.format(new Date(iso)) : '');

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children == null ? [] : children)) if (c != null && c !== false) n.append(c);
    return n;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, children) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
    for (const c of [].concat(children || [])) if (c != null) n.append(c);
    return n;
  }
  const ICONS = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
    pay: 'M3 6h18v12H3zM3 10h18M7 15h4',
    wallet: 'M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4zM4 7V5h12v2M15 13.5h2',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14',
    sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
    menu: 'M4 7h16M4 12h16M4 17h16',
    close: 'M6 6l12 12M18 6L6 18',
    back: 'M15 6l-6 6 6 6',
    phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
    bank: 'M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18',
    card: 'M3 6h18v12H3zM3 10h18M7 15h4',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
    swap: 'M4 8h14l-3-3M20 16H6l3 3',
    tower: 'M4 21V5l8-2v18M12 9h8v12M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2',
    coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 8h8M12 8v9M8.5 11.5c2.2.7 4.8.7 7 0',
    cash: 'M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 10v4M18 10v4',
  };
  function icon(name, size) {
    return svg('svg', { width: size || 20, height: size || 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
      [svg('path', { d: ICONS[name] })]);
  }
  // Marca: un boleto con la línea de corte (sin parecido a ningún logo real)
  function brandMark(size) {
    return svg('svg', { width: size || 26, height: size || 26, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, [
      svg('path', { fill: 'currentColor', 'fill-rule': 'evenodd',
        d: 'M4 4h16a2 2 0 0 1 2 2v3a3 3 0 0 0 0 6v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a3 3 0 0 0 0-6V6a2 2 0 0 1 2-2zM14.25 6.5h1.5v2.6h-1.5zM14.25 10.7h1.5v2.6h-1.5zM14.25 14.9h1.5v2.6h-1.5z' }),
    ]);
  }
  function brandLink(href) {
    return el('a', { class: 'brand', href: href || '#/', 'aria-label': BRAND.name + ', inicio' }, [brandMark(), el('span', { translate: 'no', text: BRAND.name })]);
  }
  const spinner = () => el('span', { class: 'spinner', 'aria-hidden': 'true' });
  function announce(msg) {
    const s = $('announcer');
    s.textContent = '';
    setTimeout(() => { s.textContent = msg; }, 60);
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      btn._kids = [...btn.childNodes];
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.replaceChildren(spinner(), label || 'Procesando…');
    } else {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if (btn._kids) btn.replaceChildren(...btn._kids);
    }
  }
  function selectText(node) { const r = document.createRange(); r.selectNodeContents(node); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  function copyButton(value, label, target) {
    const b = el('button', { class: 'copy', type: 'button', text: 'Copiar', 'aria-label': 'Copiar ' + label });
    b.addEventListener('click', () => {
      const done = () => {
        b.textContent = 'Copiado'; b.dataset.done = '1'; announce(label.charAt(0).toUpperCase() + label.slice(1) + ' copiado');
        setTimeout(() => { b.textContent = 'Copiar'; delete b.dataset.done; }, 2200);
      };
      const fallback = () => { if (target) selectText(target); };
      try { navigator.clipboard.writeText(value).then(done, fallback); } catch (_) { fallback(); }
    });
    return b;
  }
  function codeBlock(code, title) {
    const c = el('code', { translate: 'no', text: code });
    const pre = el('pre', { tabindex: '0', 'aria-label': 'Código: ' + (title || 'ejemplo') }, [c]);
    return el('div', { class: 'code' }, [
      el('div', { class: 'code-head' }, [el('span', { text: title || '' }), copyButton(code, 'código', c)]),
      pre,
    ]);
  }
  function pill(text, tone) { return el('span', { class: 'pill' + (tone ? ' ' + tone : ''), text }); }
  function statusPill(s) { const [t, tone] = STATUS[s] || [s, '']; return pill(t, tone); }
  function skel(n) { return el('div', { class: 'skel', 'aria-hidden': 'true' }, Array.from({ length: n || 4 }, () => el('span'))); }
  function loading(text) { return el('div', { class: 'boot', role: 'status' }, [spinner(), text || 'Cargando…']); }
  function errorBanner(err, title) {
    return el('div', { class: 'banner bad', role: 'alert' }, [
      el('b', { text: title || 'No pudimos completar la operación' }),
      el('span', { text: (err && err.message) || 'Algo salió mal. Intenta de nuevo.' }),
    ]);
  }
  function emptyState(title, text, action) {
    return el('div', { class: 'empty' }, [el('b', { text: title }), el('p', { text }), action || null]);
  }
  function money(minor, cur, cls) { return el('span', { class: 'num' + (cls ? ' ' + cls : ''), text: fmt(minor, cur) }); }

  // ---------------------------------------------------------------------------
  // Campos de formulario con error en línea (aria-invalid + aria-describedby)
  // ---------------------------------------------------------------------------
  function field(opts) {
    const id = opts.id;
    const input = opts.input || el(opts.tag || 'input', Object.assign({ id, name: opts.name || id }, opts.attrs || {}), opts.options || null);
    if (!input.id) input.id = id;
    const hint = opts.hint ? el('span', { class: 'hint', id: id + '-hint' }, opts.hint) : null;
    if (hint) input.setAttribute('aria-describedby', id + '-hint');
    const f = el('div', { class: 'field' + (opts.full ? ' full' : '') }, [el('label', { for: id, text: opts.label }), opts.wrap ? opts.wrap(input) : input, hint]);
    return f;
  }
  function setError(input, msg) {
    const f = input.closest('.field');
    const id = input.id + '-err';
    const old = $(id);
    if (old) old.remove();
    const desc = (input.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== id);
    if (msg) {
      input.setAttribute('aria-invalid', 'true');
      desc.push(id);
      (f || input.parentNode).append(el('span', { class: 'err', id, text: msg }));
    } else input.removeAttribute('aria-invalid');
    if (desc.length) input.setAttribute('aria-describedby', desc.join(' ')); else input.removeAttribute('aria-describedby');
  }
  // checks: [[input, fn(value) → mensaje|null], ...]; enfoca el primer error
  function validate(checks) {
    let first = null;
    for (const [input, fn] of checks) {
      const msg = fn(input.value);
      setError(input, msg);
      if (msg && !first) first = input;
    }
    if (first) first.focus();
    return !first;
  }
  const RIF_RE = /^[JGVEP]-?\d{8}-?\d$/;
  function normRif(v) {
    const s = String(v).trim().toUpperCase().replace(/\s/g, '');
    const m = /^([JGVEP])-?(\d{8})-?(\d)$/.exec(s);
    return m ? m[1] + '-' + m[2] + '-' + m[3] : s;
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // ---------------------------------------------------------------------------
  // Diálogos (<dialog> modal, el foco vuelve a quien lo abrió)
  // ---------------------------------------------------------------------------
  let dlgSeq = 0;
  function openDialog(opts) {
    const opener = document.activeElement;
    const hid = 'dlg-h-' + (++dlgSeq);
    const d = el('dialog', { class: opts.drawer ? 'drawer' : '', 'aria-labelledby': hid });
    const box = el('div', { class: 'dlg' });
    const x = el('button', { class: 'x-btn', type: 'button', 'aria-label': 'Cerrar' }, [icon('close')]);
    x.addEventListener('click', () => d.close());
    const api = {
      dialog: d,
      close: () => d.close(),
      set(title, nodes) {
        box.replaceChildren(el('h2', { id: hid, tabindex: '-1', text: title }), x, ...[].concat(nodes).filter(Boolean));
      },
    };
    api.set(opts.title, opts.body ? opts.body(api) : []);
    d.append(box);
    d.addEventListener('close', () => {
      d.remove();
      if (opts.onClose) opts.onClose();
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      else { const h = document.querySelector('main h1'); if (h) h.focus(); }
    });
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    document.body.append(d);
    d.showModal();
    const first = box.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
    if (first && !opts.focusTitle) first.focus(); else $(hid).focus();
    return api;
  }
  // Confirmación con acción asíncrona; el error se muestra dentro del diálogo
  function confirmAction(o) {
    openDialog({
      title: o.title,
      focusTitle: true,
      body: (dlg) => {
        const err = el('div');
        const go = el('button', { class: 'btn ' + (o.danger ? 'danger' : ''), type: 'button', text: o.label });
        go.addEventListener('click', async () => {
          setBusy(go, true, o.busy || 'Procesando…');
          err.replaceChildren();
          try { const r = await o.action(); dlg.close(); if (o.done) o.done(r); }
          catch (e) { setBusy(go, false); err.replaceChildren(errorBanner(e)); }
        });
        return [el('p', { text: o.text }), err, el('div', { class: 'dlg-actions' }, [
          el('button', { class: 'btn quiet', type: 'button', text: o.cancel || 'Volver', onclick: () => dlg.close() }), go])];
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Cliente de la API: misma interfaz en el servidor y en modo demostración
  // ---------------------------------------------------------------------------
  function qs(params) {
    if (!params) return '';
    const p = Object.entries(params).filter(([, v]) => v != null && v !== '');
    return p.length ? '?' + new URLSearchParams(p).toString() : '';
  }
  async function request(method, path, body, params) {
    let data;
    try {
      if (!IS_SERVER) data = await window.DemoApi.request(method, path, body, params);
      else {
        const url = (path.startsWith('/api/') ? path : '/api/dashboard' + path) + qs(params);
        let res;
        try {
          res = await fetch(url, {
            method, credentials: 'same-origin',
            headers: Object.assign({ Accept: 'application/json' }, method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' } : {}),
            body: body != null ? JSON.stringify(body) : (method !== 'GET' ? '{}' : undefined),
          });
        } catch (_) {
          throw { status: 0, code: 'network_error', message: 'No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.' };
        }
        let json = null;
        try { json = await res.json(); } catch (_) { /* sin cuerpo */ }
        if (!res.ok) {
          const e = (json && json.error) || {};
          throw { status: res.status, code: e.code || 'http_' + res.status, message: e.message || 'El servidor respondió con un error (' + res.status + '). Intenta de nuevo.' };
        }
        data = json;
      }
    } catch (e) {
      const err = { status: e.status || 0, code: e.code || 'unknown', message: e.message || 'Algo salió mal. Intenta de nuevo.' };
      if (err.status === 401 && err.code === 'unauthenticated') {
        state.session = null;
        if (parseHash().path.startsWith('/dashboard')) go('#/entrar?next=' + encodeURIComponent(location.hash.slice(1)));
      }
      throw err;
    }
    return data;
  }
  const api = {
    get: (path, params) => request('GET', path, null, params),
    post: (path, body) => request('POST', path, body || {}),
    put: (path, body) => request('PUT', path, body || {}),
  };

  // ---------------------------------------------------------------------------
  // Estado y router
  // ---------------------------------------------------------------------------
  const state = { session: undefined, renders: 0, cleanups: [] };
  function parseHash() {
    const raw = decodeURI(location.hash.replace(/^#/, '')) || '/';
    const [p, q = ''] = raw.split('?');
    const path = ('/' + p.replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
    return { path, parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(q)) };
  }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
  function setQuery(obj) {
    const r = parseHash();
    const q = Object.assign({}, r.query, obj);
    Object.keys(q).forEach((k) => { if (q[k] == null || q[k] === '') delete q[k]; });
    const s = new URLSearchParams(q).toString();
    history.replaceState(null, '', '#' + r.path + (s ? '?' + s : ''));
  }
  const alive = (tok) => tok === state.renders;
  async function ensureSession() {
    if (state.session !== undefined) return state.session;
    try { state.session = await api.get('/me'); } catch (_) { state.session = null; }
    return state.session;
  }

  async function render() {
    state.cleanups.splice(0).forEach((f) => { try { f(); } catch (_) { /* nada */ } });
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    const tok = ++state.renders;
    const first = tok === 1;
    const r = parseHash();
    const app = $('app');
    const p = r.parts;
    let focusTarget = null;

    if (p[0] === 'dashboard') {
      const s = await ensureSession();
      if (!alive(tok)) return;
      if (!s) { go('#/entrar?next=' + encodeURIComponent(r.path + (location.hash.includes('?') ? '?' + location.hash.split('?')[1] : ''))); return; }
      const main = dashShell(app, p[1] || '');
      const view = DASH[p[1] || ''];
      if (!view || (p.length > 3) || (p[2] && p[1] !== 'pagos')) notFound(main);
      else view(main, r, tok);
    } else if (p[0] === 'entrar' || p[0] === 'registro') {
      if (state.session === undefined) ensureSession();
      authPage(app, p[0], r);
    } else if (!p.length || p[0] === 'precios') {
      const main = publicShell(app, p[0] === 'precios' ? 'precios' : 'inicio');
      landing(main);
      if (p[0] === 'precios') focusTarget = $('precios-h');
    } else if (p[0] === 'docs') {
      const main = publicShell(app, 'docs');
      docs(main, p[1]);
      if (p[1]) focusTarget = $('doc-' + p[1]);
    } else {
      const main = publicShell(app, '');
      notFound(main);
    }
    const skip = $('skip-link');
    skip.onclick = (e) => { e.preventDefault(); const m = document.querySelector('main'); if (m) { m.focus(); } };

    requestAnimationFrame(() => {
      if (!alive(tok)) return;
      if (focusTarget) { focusTarget.scrollIntoView({ block: 'start' }); if (!first) focusTarget.focus({ preventScroll: true }); return; }
      window.scrollTo(0, 0);
      if (!first) { const h = document.querySelector('main h1'); if (h) h.focus({ preventScroll: true }); }
    });
  }
  function setTitle(t) { document.title = t ? t + ' | ' + BRAND.name : BRAND.name + ': cobra en bolívares, dólares y USDT'; }

  // ---------------------------------------------------------------------------
  // Marco público
  // ---------------------------------------------------------------------------
  function publicShell(app, current) {
    const items = () => [
      el('a', { href: '#/precios', text: 'Precios', 'aria-current': current === 'precios' ? 'page' : false }),
      el('a', { href: '#/docs', text: 'Documentación', 'aria-current': current === 'docs' ? 'page' : false }),
      state.session ? el('a', { class: 'btn', href: '#/dashboard', text: 'Ir al panel' }) : el('a', { href: '#/entrar', text: 'Entrar' }),
      state.session ? null : el('a', { class: 'btn', href: '#/registro', text: 'Crear cuenta' }),
    ];
    const nav = el('nav', { class: 'site-nav', id: 'site-nav', 'aria-label': 'Principal' }, items());
    // La sesión se consulta en segundo plano: si hay una, "Entrar" pasa a "Ir al panel"
    if (state.session === undefined) ensureSession().then(() => { if (nav.isConnected && state.session) nav.replaceChildren(...items().filter(Boolean)); });
    const menu = el('button', { class: 'btn quiet sm menu-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'site-nav' }, [icon('menu'), 'Menú']);
    menu.addEventListener('click', () => {
      const open = menu.getAttribute('aria-expanded') !== 'true';
      menu.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('open', open);
    });
    const main = el('main', { class: 'site-main', id: 'main', tabindex: '-1' });
    app.replaceChildren(
      el('header', { class: 'site-header' }, [el('div', { class: 'wrap' }, [brandLink('#/'), menu, nav])]),
      main,
      el('footer', { class: 'site-footer' }, [el('div', { class: 'wrap' }, [
        el('div', {}, [brandLink('#/'), el('p', { class: 'small', text: 'Pagos en bolívares, dólares y USDT para comercios en Venezuela.' })]),
        el('nav', { 'aria-label': 'Pie de página' }, [
          el('a', { href: '#/precios', text: 'Precios' }), el('a', { href: '#/docs', text: 'Documentación' }),
          el('a', { href: '#/docs/pruebas', text: 'Modo de prueba' }), el('a', { href: '#/entrar', text: 'Entrar' }),
        ]),
      ])]),
    );
    return main;
  }

  // ---------------------------------------------------------------------------
  // Landing
  // ---------------------------------------------------------------------------
  // Ejemplo calculado con la misma aritmética del servidor (bigint, half-even)
  function worked(priceMinor, rate, m) {
    const S = 10n ** 12n;
    const [ri, rf = ''] = rate.split('.');
    const rs = BigInt(ri) * S + BigInt((rf + '0'.repeat(12)).slice(0, 12));
    const he = (n, d) => { const q = n / d, rr = n % d; return (rr * 2n > d || (rr * 2n === d && q % 2n === 1n)) ? q + 1n : q; };
    const charge = he(BigInt(priceMinor) * rs, S);
    const fixed = he(BigInt(m.fixed) * rs, S);
    const fee = he(charge * BigInt(m.bps), 10000n) + fixed;
    const tax = he(fee * BigInt(m.tax), 10000n);
    return { charge: String(charge), fee: String(fee), tax: String(tax), net: String(charge - fee - tax) };
  }

  function landing(main) {
    setTitle('');
    const c2p = PRICING[0];
    const demoCharge = worked('2500', '36.5', c2p).charge;
    const hero = el('section', { class: 'hero', 'aria-labelledby': 'hero-h' }, [el('div', { class: 'wrap' }, [
      el('div', {}, [
        el('h1', { id: 'hero-h', tabindex: '-1', text: 'Cobra en bolívares, dólares y USDT con una sola integración.' }),
        el('p', { class: 'lede', text: 'Pago Móvil, débito inmediato, tarjetas, Zelle, USDT y efectivo en un mismo checkout. La tasa se congela en el momento en que tu cliente paga: el monto que ve es el que cobras.' }),
        el('div', { class: 'ctas' }, [
          el('a', { class: 'btn lg', href: '#/registro', text: 'Crear cuenta' }),
          el('a', { class: 'btn lg ghost', href: '#/docs', text: 'Leer la documentación' }),
        ]),
        el('p', { class: 'fine', text: 'Empiezas en modo de prueba, sin papeleo. Activas los cobros reales cuando envíes los datos de tu empresa.' }),
      ]),
      el('figure', { class: 'receipt-demo', 'aria-label': 'Ejemplo del checkout: un pedido de 25 dólares pagado por Pago Móvil con la tasa BCV congelada', style: 'margin:0' }, [
        el('div', { class: 'receipt-card', 'aria-hidden': 'true' }, [
          el('div', { class: 'who' }, [el('div', { class: 'mark', text: 'C' }), el('div', {}, [el('b', { text: 'Café El Ávila' }), el('span', { text: 'Pedido #1043' })])]),
          el('div', {}, [el('div', { class: 'total-k', text: 'Total del pedido' }), el('div', { class: 'total' }, ['25,00', el('small', { text: 'USD' })])]),
          el('div', { class: 'pay-row' }, [el('span', { class: 'tick' }), el('div', {}, [el('b', { text: 'Pago Móvil' }), el('span', { text: 'Con la clave de pago de tu banco' })])]),
          el('div', { class: 'ticket' }, [
            el('div', { class: 'ticket-main' }, [
              el('span', { class: 'ticket-k', text: 'Pagas con Pago Móvil' }),
              el('span', { class: 'ticket-amount', text: fmt(demoCharge, 'VES') }),
              el('span', { class: 'ticket-line' }, ['Tasa BCV: ', el('span', { class: 'fig', text: '1 USD = 36,50 Bs' })]),
            ]),
            el('div', { class: 'ticket-tear' }),
            el('div', { class: 'ticket-stub' }, [el('span', { class: 'dot' }), 'Tasa congelada para este pago']),
          ]),
          el('div', { class: 'fake-btn', text: 'Pagar ' + fmt(demoCharge, 'VES') }),
        ]),
      ]),
    ])]);

    const methods = [
      ['phone', 'Pago Móvil C2P y P2P', 'Con clave de pago o por transferencia desde la app del banco.', 'Bs'],
      ['bank', 'Débito inmediato', 'Cargo directo a la cuenta del cliente en bancos nacionales.', 'Bs'],
      ['card', 'Tarjetas nacionales', 'Débito y crédito emitidas en Venezuela.', 'Bs'],
      ['globe', 'Tarjetas internacionales', 'Visa, Mastercard y Amex emitidas fuera del país.', 'USD'],
      ['swap', 'Zelle', 'Le mostramos al cliente el correo y el concepto exactos.', 'USD'],
      ['tower', 'Banesco Panamá', 'Transferencias en dólares entre cuentas de Banesco Panamá.', 'USD'],
      ['coin', 'USDT', 'Por las redes TRC-20 (TRON) y Polygon, con QR y monto exacto.', 'USDT'],
      ['cash', 'Efectivo en dólares', 'En taquillas aliadas, con el IGTF incluido en el monto.', 'USD'],
    ];
    const methodsSec = el('section', { class: 'section', 'aria-labelledby': 'met-h' }, [el('div', { class: 'wrap' }, [
      el('div', { class: 'section-head' }, [
        el('h2', { id: 'met-h', text: 'Todos los métodos que usan tus clientes' }),
        el('p', { text: 'Tu cliente elige cómo pagar. Tú integras una sola API y ves todo en el mismo panel, en la moneda en que se cobró.' }),
      ]),
      el('ul', { class: 'methods-grid' }, methods.map(([ic, name, sub, cur]) => el('li', {}, [
        el('span', { class: 'ico' }, [icon(ic, 22)]), el('b', {}, [name, el('span', { class: 'cur', text: cur })]), el('span', { text: sub }),
      ]))),
    ])]);

    const steps = el('section', { class: 'section', 'aria-labelledby': 'how-h' }, [el('div', { class: 'wrap' }, [
      el('div', { class: 'section-head' }, [el('h2', { id: 'how-h', text: 'Cómo funciona' })]),
      el('ol', { class: 'steps3' }, [
        el('li', {}, [el('h3', { text: 'Creas el pago' }), el('p', { text: 'Desde tu servidor, con el precio en dólares o en bolívares. También puedes crear un link de pago desde el panel, sin programar.' })]),
        el('li', {}, [el('h3', { text: 'Tu cliente paga' }), el('p', { text: 'En el checkout elige el método, ve el monto en su moneda y paga. La tasa queda congelada desde que confirma.' })]),
        el('li', {}, [el('h3', { text: 'Recibes tu dinero' }), el('p', { text: 'Te avisamos por webhook y liquidamos tu saldo según tu regla: todo en bolívares o repartido entre Bs y USDT.' })]),
      ]),
    ])]);

    const curl = 'curl ' + API_BASE + '/v1/payment_intents \\\n  -H "Authorization: Bearer sk_test_…" \\\n  -H "Idempotency-Key: pedido-1043" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"amount": "2500", "currency": "USD", "metadata": {"pedido": "1043"}}\'';
    const dev = el('section', { class: 'section', 'aria-labelledby': 'dev-h' }, [el('div', { class: 'wrap dev-split' }, [
      el('div', {}, [
        el('div', { class: 'section-head', style: 'margin-bottom:0' }, [
          el('h2', { id: 'dev-h', text: 'Una API pensada para montos exactos' }),
          el('p', { text: 'Los montos viajan como enteros en unidades mínimas: nada de céntimos perdidos por redondeo.' }),
        ]),
        el('ul', {}, [
          el('li', { text: 'Idempotency-Key en cada POST: un reintento nunca cobra dos veces.' }),
          el('li', { text: 'Checkout alojado o confirmación desde tu servidor.' }),
          el('li', { text: 'Webhooks firmados con HMAC-SHA256 y reintentos automáticos.' }),
          el('li', { text: 'Sandbox separado de producción, con valores para simular rechazos.' }),
        ]),
        el('p', { style: 'margin-top:20px' }, [el('a', { href: '#/docs/crear-pago', text: 'Ver cómo crear un pago' })]),
      ]),
      codeBlock(curl, 'Crear un pago de USD 25,00'),
    ])]);

    const ex = worked('10000', '36.5', c2p);
    const pricing = el('section', { class: 'section', id: 'precios', 'aria-labelledby': 'precios-h' }, [el('div', { class: 'wrap' }, [
      el('div', { class: 'section-head' }, [
        el('h2', { id: 'precios-h', tabindex: '-1', text: 'Precios por cobro exitoso' }),
        el('p', { text: 'Pagas una comisión por cada pago cobrado, según el método. La parte fija se fija en dólares y se convierte con la tasa del cobro.' }),
      ]),
      el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Tabla de precios' }, [el('table', { id: 'pricing-table', class: 'stack-sm' }, pricingRows())]),
      el('div', { class: 'example' }, [
        el('p', { class: 'muted' }, [
          'Ejemplo: un pedido de ', el('span', { class: 'num', text: 'USD 100,00' }), ' pagado por Pago Móvil con tasa BCV de 36,50. Tu cliente paga ',
          money(ex.charge, 'VES'), '; la comisión es ', money(ex.fee, 'VES'), ' (1,5 % + USD 0,05), el IVA ', money(ex.tax, 'VES'), ' y recibes ', money(ex.net, 'VES'), '.',
        ]),
        el('p', { class: 'muted', text: 'IVA de 16 % sobre la comisión en los métodos en bolívares. El IGTF de 3 % solo aplica al efectivo en divisas: lo paga el cliente encima del precio (USD 50,00 se convierten en USD 51,50) y lo retenemos para el SENIAT.' }),
      ]),
    ])]);
    if (IS_SERVER) {
      api.get('/api/public/methods').then((list) => {
        (list || []).forEach((m) => {
          const row = PRICING.find((x) => x.type === m.type);
          if (row) Object.assign(row, { cur: m.currency, bps: m.fee_bps, fixed: String(m.fixed_usd), tax: m.tax_bps, igtf: m.igtf_bps });
        });
        const t = $('pricing-table');
        if (t) t.replaceChildren(...pricingRows());
      }).catch(() => { /* se queda con la tabla local */ });
    }

    const split = el('section', { class: 'section', 'aria-labelledby': 'split-h' }, [el('div', { class: 'wrap' }, [
      el('div', { class: 'split-demo' }, [
        el('div', { class: 'section-head', style: 'margin:0' }, [
          el('h2', { id: 'split-h', text: 'Liquida en la mezcla que te sirve' }),
          el('p', { text: 'Define qué parte de tu saldo en bolívares recibes en tu banco y qué parte en USDT. Las porciones convertidas usan la tasa del momento del corte y verás el spread de cobertura en cada liquidación.' }),
        ]),
        el('div', {}, [
          el('div', { class: 'split-bar', role: 'img', 'aria-label': 'Regla de ejemplo: 60 % en bolívares y 40 % en USDT' }, [el('span', { class: 'a', text: '60 % Bs' }), el('span', { class: 'b', text: '40 % USDT' })]),
          el('dl', { class: 'split-lines' }, [
            el('div', {}, [el('dt', { text: 'Saldo disponible' }), el('dd', {}, [money(ex.net, 'VES')])]),
            el('div', {}, [el('dt', { text: 'A tu cuenta en Bs' }), el('dd', {}, [money('215063', 'VES')])]),
            el('div', {}, [el('dt', { text: 'Convertido a USDT a 38,20' }), el('dd', {}, [money('37082461', 'USDT')])]),
            el('div', {}, [el('dt', { text: 'Spread de 1,2 % sobre la porción convertida' }), el('dd', {}, [money('1720', 'VES')])]),
          ]),
        ]),
      ]),
      el('div', { class: 'cta-band' }, [
        el('div', {}, [el('h2', { text: 'Prueba la integración hoy mismo' }), el('p', { text: 'Crea tu cuenta, toma tus llaves de prueba y haz tu primer cobro de ensayo.' })]),
        el('a', { class: 'btn lg', href: '#/registro', text: 'Crear cuenta' }),
      ]),
    ])]);
    main.replaceChildren(hero, methodsSec, steps, dev, pricing, split);
  }
  function pricingRows() {
    return [
      el('caption', { class: 'sr-only', text: 'Comisión por método de pago' }),
      el('thead', {}, [el('tr', {}, ['Método', 'Cobras en', 'Comisión', 'IVA', 'IGTF'].map((t) => el('th', { scope: 'col', text: t })))]),
      el('tbody', {}, PRICING.map((m) => el('tr', {}, [
        el('th', { scope: 'row', text: m.name }),
        el('td', { 'data-label': 'Cobras en', text: SYMBOL[m.cur] }),
        el('td', { 'data-label': 'Comisión' }, [el('span', { class: 'num', text: pct(m.bps) + (m.fixed !== '0' ? ' + ' + fmt(m.fixed, 'USD') : '') })]),
        el('td', { 'data-label': 'IVA', text: m.tax ? pct(m.tax) + ' sobre la comisión' : 'No aplica' }),
        el('td', { 'data-label': 'IGTF', text: m.igtf ? pct(m.igtf) + ', lo paga el cliente' : 'No aplica' }),
      ]))),
    ];
  }

  // ---------------------------------------------------------------------------
  // Documentación
  // ---------------------------------------------------------------------------
  function code(t) { return el('code', { translate: 'no', text: t }); }
  function P(...parts) { return el('p', {}, parts.map((x) => (typeof x === 'string' ? x : x))); }
  function simpleTable(head, rows, label) {
    return el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': label }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, head.map((h) => el('th', { scope: 'col', text: h })))]),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, [].concat(c)))))),
    ])]);
  }
  const DOCS = [
    ['introduccion', 'Introducción'], ['autenticacion', 'Autenticación'], ['crear-pago', 'Crear un pago'],
    ['checkout', 'Checkout alojado'], ['metodos', 'Métodos y monedas'], ['confirmar', 'Confirmar desde tu servidor'],
    ['webhooks', 'Webhooks'], ['errores', 'Errores'], ['pruebas', 'Pruebas'],
  ];
  function docs(main, active) {
    setTitle('Documentación');
    const cur = DOCS.some(([id]) => id === active) ? active : 'introduccion';
    const navLinks = DOCS.map(([id, t]) => el('a', { href: '#/docs/' + id, 'data-sec': id, text: t, 'aria-current': id === cur ? 'true' : false }));
    const nav = el('nav', { class: 'docs-nav', 'aria-labelledby': 'docs-nav-h' }, [el('h2', { id: 'docs-nav-h', text: 'En esta guía' }), el('ol', {}, navLinks.map((a) => el('li', {}, [a])))]);
    const sec = (id, title, kids) => el('section', { class: 'doc-sec', id: 'sec-' + id, 'aria-labelledby': 'doc-' + id }, [el('h2', { id: 'doc-' + id, tabindex: '-1', text: title }), ...kids]);
    const B = API_BASE;
    const createRes = JSON.stringify({
      id: 'pi_3f9a1c2e8b7d40', object: 'payment_intent', status: 'requires_payment_method', amount: '2500', currency: 'USD',
      client_secret: 'pi_3f9a1c2e8b7d40_secret_Xq8…', payment_method_type: null, charge: null, fx: null,
      metadata: { pedido: '1043' }, expires_at: '2026-10-17T14:05:00.000Z',
    }, null, 2);
    const nodeVerify = [
      "import crypto from 'node:crypto';",
      "import express from 'express';",
      '',
      'const app = express();',
      'const secret = process.env.WEBHOOK_SECRET; // whsec_…',
      '',
      "// Usa el cuerpo crudo: la firma se calcula sobre los bytes exactos que enviamos",
      "app.post('/webhooks/pagos', express.raw({ type: 'application/json' }), (req, res) => {",
      "  const header = req.get('Webhook-Signature') || '';",
      "  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));",
      '  const t = Number(parts.t);',
      '  // Rechaza firmas de más de 5 minutos para evitar repeticiones',
      '  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return res.sendStatus(400);',
      '',
      "  const expected = crypto.createHmac('sha256', secret)",
      '    .update(`${t}.`).update(req.body).digest();',
      "  const given = Buffer.from(parts.v1 || '', 'hex');",
      '  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {',
      '    return res.sendStatus(400);',
      '  }',
      '',
      '  const event = JSON.parse(req.body);',
      "  if (event.type === 'payment_intent.succeeded') {",
      '    // marca el pedido como pagado (de forma idempotente: puede llegar más de una vez)',
      '  }',
      '  res.sendStatus(200);',
      '});',
    ].join('\n');
    const body = el('div', { class: 'docs-body' }, [
      el('header', {}, [el('h1', { tabindex: '-1', text: 'Documentación de la API' }), el('p', { text: 'Todo lo necesario para cobrar con ' + BRAND.name + ' desde tu sitio, tu app o tu sistema de ventas.' })]),
      sec('introduccion', 'Introducción', [
        P('La API gira alrededor del ', code('PaymentIntent'), ': un pago con su precio, su estado y, cuando el cliente elige el método, el monto exacto que debe pagar en la moneda de ese método con la tasa del momento.'),
        P('El ciclo de vida es siempre el mismo:'),
        codeBlock('requires_payment_method ─attach─▶ requires_confirmation ─confirm─▶ processing ─▶ succeeded ─▶ settled\n                                                           │   ▲\n                                                           ▼   │\n                                                     requires_action\n                                        (clave C2P, 3DS, transferencia, USDT)', 'Estados de un pago'),
        P('Los montos siempre son strings de enteros en unidades mínimas: ', code('"2500"'), ' en USD son 25,00 dólares; ', code('"91250"'), ' en VES son Bs 912,50; USDT usa 6 decimales. Las fechas van en ISO 8601.'),
      ]),
      sec('autenticacion', 'Autenticación', [
        P('Cada cuenta tiene dos tipos de llave. Las ves y las rotas en ', el('a', { href: '#/dashboard/desarrolladores', text: 'Desarrolladores' }), ' del panel.'),
        el('ul', {}, [
          el('li', {}, [code('sk_test_…'), ' / ', code('sk_live_…'), ': secreta. Solo en tu servidor. Crea, confirma y cancela pagos. Te la mostramos una sola vez.']),
          el('li', {}, [code('pk_test_…'), ' / ', code('pk_live_…'), ': publicable. Va en el navegador y solo sirve junto al ', code('client_secret'), ' de un pago: no ve metadata ni puede cancelar.']),
        ]),
        codeBlock('Authorization: Bearer sk_test_51Qd…', 'Cabecera'),
        P('Prueba y producción son ambientes separados, cada uno con su base de datos. Una llave de prueba es rechazada en producción y un pago de prueba nunca toca el dinero real. Las llaves de producción se habilitan cuando tu cuenta está activa.'),
      ]),
      sec('crear-pago', 'Crear un pago', [
        P('Desde tu servidor, con ', code('POST /v1/payment_intents'), '. La cabecera ', code('Idempotency-Key'), ' es obligatoria en todo POST: si repites la llamada con la misma llave, recibes la misma respuesta y no se crea un segundo pago.'),
        codeBlock('curl ' + B + '/v1/payment_intents \\\n  -H "Authorization: Bearer sk_test_…" \\\n  -H "Idempotency-Key: pedido-1043" \\\n  -H "Content-Type: application/json" \\\n  -d \'{\n    "amount": "2500",\n    "currency": "USD",\n    "customer": {"name": "Luisa Pérez", "email": "luisa@correo.example"},\n    "metadata": {"pedido": "1043"},\n    "expires_in": 86400\n  }\'', 'Solicitud'),
        codeBlock(createRes, 'Respuesta 201'),
        simpleTable(['Campo', 'Tipo', 'Descripción'], [
          [code('amount'), 'string', 'Precio en unidades mínimas de currency.'],
          [code('currency'), 'string', 'VES, USD o USDT. Es la moneda del precio, no la del cobro.'],
          [code('customer'), 'objeto', 'Opcional. Datos del pagador para conciliación.'],
          [code('metadata'), 'objeto', 'Opcional. Tus propios datos; vuelven en los webhooks.'],
          [code('expires_in'), 'número', 'Opcional. Segundos hasta que el pago venza si nadie paga.'],
        ], 'Campos para crear un pago'),
        P('Si reusas una Idempotency-Key con otro cuerpo, recibes ', code('422 idempotency_key_reused'), '; si la primera llamada sigue en curso, ', code('409'), '.'),
      ]),
      sec('checkout', 'Checkout alojado', [
        P('La forma más rápida: redirige a tu cliente a nuestra página de pago con el id, el ', code('client_secret'), ' y tu llave publicable.'),
        codeBlock(B + '/checkout?pi=pi_3f9a1c2e8b7d40&cs=pi_3f9a1c2e8b7d40_secret_Xq8…&pk=pk_test_51Qd…', 'URL del checkout'),
        P('El checkout muestra los métodos, cotiza el monto en la moneda del método con la tasa congelada y su cuenta regresiva, pide los datos de Pago Móvil C2P y da instrucciones para transferencias, Zelle, USDT (con QR) y efectivo. Se actualiza solo cuando el banco o la red confirman.'),
        P('¿No programas? Crea un ', el('a', { href: '#/dashboard/links', text: 'link de pago' }), ' en el panel: cada vez que alguien lo abre se crea un pago nuevo y se le lleva al checkout.'),
      ]),
      sec('metodos', 'Métodos y monedas', [
        P('Cada método cobra en una moneda fija. Si difiere de la moneda del precio, convertimos con la tasa de la fuente que corresponda (BCV para USD/VES, Binance P2P para USDT/VES).'),
        simpleTable(['payment_method_type', 'Método', 'Cobra en', 'Acción del cliente'], [
          [code('pago_movil_c2p'), 'Pago Móvil C2P', 'VES', 'Clave de pago en el checkout'],
          [code('pago_movil_p2p'), 'Pago Móvil P2P', 'VES', 'Transferir desde su banco'],
          [code('debito_inmediato'), 'Débito inmediato', 'VES', 'Autorizar en su banco'],
          [code('card_national'), 'Tarjeta nacional', 'VES', 'Datos de tarjeta'],
          [code('card_international'), 'Tarjeta internacional', 'USD', 'Datos de tarjeta, 3DS'],
          [code('zelle'), 'Zelle', 'USD', 'Transferir con el concepto'],
          [code('banesco_panama'), 'Banesco Panamá', 'USD', 'Transferir'],
          [code('usdt_trc20'), 'USDT TRC-20', 'USDT', 'Enviar a la dirección'],
          [code('usdt_polygon'), 'USDT Polygon', 'USDT', 'Enviar a la dirección'],
          [code('cash'), 'Efectivo en dólares', 'USD', 'Pagar en taquilla con un código'],
        ], 'Métodos de pago'),
        simpleTable(['Moneda', 'Decimales', 'Ejemplo'], [
          [code('VES'), '2', [code('"365000"'), ' = Bs 3.650,00']],
          [code('USD'), '2', [code('"2500"'), ' = USD 25,00']],
          [code('USDT'), '6', [code('"37082461"'), ' = USDT 37,082461']],
        ], 'Monedas'),
        P('Las comisiones de cada método están en la ', el('a', { href: '#/precios', text: 'tabla de precios' }), '.'),
      ]),
      sec('confirmar', 'Confirmar desde tu servidor', [
        P('Si tienes tu propio formulario de pago, adjunta el método y confirma desde tu servidor. ', code('attach'), ' cotiza el monto con su vencimiento; ', code('confirm'), ' congela la tasa y llama al banco.'),
        codeBlock('curl ' + B + '/v1/payment_intents/pi_3f9a1c2e8b7d40/attach \\\n  -H "Authorization: Bearer sk_test_…" \\\n  -H "Idempotency-Key: pedido-1043-attach" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"payment_method_type": "pago_movil_c2p"}\'', 'Adjuntar el método'),
        codeBlock('curl ' + B + '/v1/payment_intents/pi_3f9a1c2e8b7d40/confirm \\\n  -H "Authorization: Bearer sk_test_…" \\\n  -H "Idempotency-Key: pedido-1043-confirm" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"payment_method_details": {\n        "bank": "0134", "document": "V-12345678",\n        "phone": "04141234567", "otp": "123456"}}\'', 'Confirmar'),
        P('Si la cotización venció antes de confirmar recibes ', code('409 fx_quote_expired'), ': vuelve a llamar a attach y muéstrale al cliente el monto nuevo. La clave C2P se usa una sola vez y no se guarda.'),
        P('Para cancelar un pago que nadie ha pagado: ', code('POST /v1/payment_intents/:id/cancel'), '. Solo funciona en ', code('requires_payment_method'), ', ', code('requires_confirmation'), ' o ', code('requires_action'), '.'),
      ]),
      sec('webhooks', 'Webhooks', [
        P('Registra una URL https en ', el('a', { href: '#/dashboard/desarrolladores?tab=webhooks', text: 'Desarrolladores' }), ' y elige los eventos. Respondemos con reintentos y espera exponencial hasta 8 intentos si tu servidor no devuelve 2xx.'),
        simpleTable(['Evento', 'Cuándo llega'], Object.entries(EVENT_INFO).map(([k, v]) => [code(k), v]), 'Tipos de evento'),
        P('Cada envío lleva la cabecera ', code('Webhook-Signature: t=<unix>,v1=<hex>'), ', donde ', code('v1 = HMAC_SHA256(secreto, "<t>.<cuerpo crudo>")'), '. Verifícala siempre antes de confiar en el evento:'),
        codeBlock(nodeVerify, 'Node.js'),
      ]),
      sec('errores', 'Errores', [
        P('Los errores responden con un status HTTP y un cuerpo con un código estable y un mensaje en español:'),
        codeBlock('{ "error": { "code": "fx_quote_expired", "message": "La tasa venció antes de confirmar." } }', 'Cuerpo de error'),
        simpleTable(['Código', 'HTTP', 'Qué significa'], [
          [code('amount_invalid'), '422', 'El monto no es un entero positivo en unidades mínimas.'],
          [code('idempotency_key_reused'), '422', 'Usaste la misma Idempotency-Key con otro cuerpo.'],
          [code('fx_quote_expired'), '409', ERRORS.fx_quote_expired + ' Vuelve a adjuntar el método.'],
          [code('fx_rate_unavailable'), '503', 'No hay una tasa reciente para convertir a la moneda del método.'],
          [code('rail_reference_already_used'), '409', 'La referencia del banco ya se usó para otro pago.'],
          [code('payment_intent_unexpected_state'), '409', 'La operación no está permitida en el estado actual del pago.'],
          [code('payment_intent_expired'), '409', ERRORS.payment_intent_expired],
          [code('insufficient_funds'), '402', ERRORS.insufficient_funds],
          [code('invalid_c2p_token'), '402', ERRORS.invalid_c2p_token],
          [code('do_not_honor'), '402', ERRORS.do_not_honor],
          [code('card_declined'), '402', ERRORS.card_declined],
          [code('action_expired'), '402', ERRORS.action_expired],
          [code('bank_unavailable'), '503', ERRORS.bank_unavailable],
          [code('resource_missing'), '404', 'No existe ese pago, o no es de tu cuenta.'],
        ], 'Códigos de error'),
        P('Los rechazos del banco no son errores HTTP de la confirmación: el pago vuelve a ', code('requires_payment_method'), ' con ', code('last_payment_error'), ' y el cliente puede reintentar con otro método.'),
      ]),
      sec('pruebas', 'Pruebas', [
        P('Con llaves ', code('sk_test_'), ' todos los bancos están simulados. Para probar rechazos en Pago Móvil C2P usa estos teléfonos:'),
        simpleTable(['Teléfono termina en', 'Resultado'], [
          [code('0002'), 'Fondos insuficientes (insufficient_funds)'],
          [code('0003'), 'Clave C2P inválida (invalid_c2p_token)'],
          ['Cualquier otro', 'Pago aprobado'],
        ], 'Valores de prueba'),
        P('Las transferencias (Pago Móvil P2P, Zelle, USDT, efectivo) quedan en ', code('requires_action'), ' hasta que el sandbox simula la llegada del dinero. Desde ', el('a', { href: '#/dashboard/desarrolladores?tab=webhooks', text: 'Desarrolladores' }), ' puedes enviar un evento de prueba a tu endpoint.'),
      ]),
    ]);
    main.replaceChildren(el('div', { class: 'wrap docs' }, [nav, body]));
    // Resalta la sección visible en el índice
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          const id = en.target.id.replace('sec-', '');
          navLinks.forEach((a) => { if (a.dataset.sec === id) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
        });
      }, { rootMargin: '0px 0px -70% 0px' });
      body.querySelectorAll('.doc-sec').forEach((s) => io.observe(s));
      state.cleanups.push(() => io.disconnect());
    }
  }

  // ---------------------------------------------------------------------------
  // Entrar / registro
  // ---------------------------------------------------------------------------
  function pwField(id, label, autocomplete, hint) {
    const input = el('input', { id, name: 'password', type: 'password', autocomplete, required: true, spellcheck: 'false', autocapitalize: 'off' });
    const toggle = el('button', { class: 'pw-toggle', type: 'button', 'aria-pressed': 'false', 'aria-controls': id, text: 'Mostrar', 'aria-label': 'Mostrar contraseña' });
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Ocultar' : 'Mostrar';
      toggle.setAttribute('aria-pressed', String(show));
    });
    return field({ id, label, input, hint, wrap: (i) => el('div', { class: 'pw-wrap' }, [i, toggle]) });
  }
  function authPage(app, kind, r) {
    const signup = kind === 'registro';
    setTitle(signup ? 'Crear cuenta' : 'Entrar');
    const err = el('div');
    const btn = el('button', { class: 'btn lg block', type: 'submit', text: signup ? 'Crear cuenta' : 'Entrar' });
    const form = el('form', { class: 'form', novalidate: true });
    let checks;
    if (signup) {
      const name = field({ id: 'su-name', label: 'Tu nombre', attrs: { autocomplete: 'name', required: true, placeholder: 'María Fernández…' } });
      const email = field({ id: 'su-email', label: 'Correo', attrs: { type: 'email', autocomplete: 'email', required: true, spellcheck: 'false', autocapitalize: 'off', placeholder: 'tu@negocio.com…' } });
      const biz = field({ id: 'su-biz', label: 'Nombre del negocio', attrs: { autocomplete: 'organization', required: true, placeholder: 'Café El Ávila…' } });
      const rif = field({ id: 'su-rif', label: 'RIF', attrs: { autocomplete: 'off', required: true, spellcheck: 'false', autocapitalize: 'characters', translate: 'no', placeholder: 'J-12345678-9…' }, hint: 'Con la letra inicial: J, G, V, E o P.' });
      const rule = el('span', { class: 'rule', id: 'su-pass-hint', text: 'Al menos 10 caracteres' });
      const pw = pwField('su-pass', 'Contraseña', 'new-password', [rule]);
      const pwInput = pw.querySelector('input');
      pwInput.addEventListener('input', () => { if (pwInput.value.length >= 10) rule.dataset.ok = '1'; else delete rule.dataset.ok; });
      form.append(name, email, biz, rif, pw);
      const v = (f) => f.querySelector('input');
      checks = [
        [v(name), (x) => (x.trim() ? null : 'Escribe tu nombre.')],
        [v(email), (x) => (EMAIL_RE.test(x.trim()) ? null : 'Escribe un correo válido, como tu@negocio.com.')],
        [v(biz), (x) => (x.trim() ? null : 'Escribe el nombre de tu negocio.')],
        [v(rif), (x) => (RIF_RE.test(x.trim().toUpperCase()) ? null : 'El RIF debe tener la forma J-12345678-9.')],
        [pwInput, (x) => (x.length >= 10 ? null : 'La contraseña debe tener al menos 10 caracteres.')],
      ];
    } else {
      const email = field({ id: 'li-email', label: 'Correo', attrs: { type: 'email', autocomplete: 'email', required: true, spellcheck: 'false', autocapitalize: 'off', placeholder: 'tu@negocio.com…' } });
      const pw = pwField('li-pass', 'Contraseña', 'current-password');
      form.append(email, pw);
      checks = [
        [email.querySelector('input'), (x) => (EMAIL_RE.test(x.trim()) ? null : 'Escribe un correo válido, como tu@negocio.com.')],
        [pw.querySelector('input'), (x) => (x ? null : 'Escribe tu contraseña.')],
      ];
    }
    form.append(err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.replaceChildren();
      if (!validate(checks)) return;
      setBusy(btn, true, signup ? 'Creando tu cuenta…' : 'Entrando…');
      try {
        const vals = checks.map(([i]) => i.value);
        const s = signup
          ? await api.post('/signup', { name: vals[0].trim(), email: vals[1].trim(), business_name: vals[2].trim(), rif: normRif(vals[3]), password: vals[4] })
          : await api.post('/login', { email: vals[0].trim(), password: vals[1] });
        state.session = s;
        const next = r.query.next && r.query.next.startsWith('/dashboard') ? r.query.next : '/dashboard';
        go('#' + next);
      } catch (ex) {
        setBusy(btn, false);
        const title = ex.code === 'invalid_credentials' ? 'No pudimos entrar' : ex.code === 'too_many_attempts' ? 'Demasiados intentos' : 'No pudimos crear la cuenta';
        err.replaceChildren(errorBanner(ex, signup ? (ex.code === 'too_many_attempts' ? title : 'No pudimos crear la cuenta') : title));
        err.querySelector('[role=alert]').scrollIntoView({ block: 'center' });
      }
    });
    const card = el('div', { class: 'auth-card' }, [
      el('div', {}, [
        el('h1', { tabindex: '-1', text: signup ? 'Crea tu cuenta' : 'Entra a tu panel' }),
        el('p', { class: 'sub', text: signup ? 'Empiezas en modo de prueba. Para cobrar de verdad, activas la cuenta con los datos de tu empresa.' : 'Con el correo y la contraseña de tu cuenta.' }),
      ]),
      form,
      el('p', { class: 'auth-alt' }, signup ? ['¿Ya tienes cuenta? ', el('a', { href: '#/entrar', text: 'Entrar' })] : ['¿No tienes cuenta? ', el('a', { href: '#/registro', text: 'Crear cuenta' })]),
      IS_SERVER ? null : el('p', { class: 'banner note small', text: 'Modo de demostración: datos de ejemplo. Cualquier correo y contraseña válidos sirven.' }),
    ]);
    app.replaceChildren(el('div', { class: 'auth' }, [
      el('header', { class: 'auth-top' }, [el('div', { class: 'wrap' }, [brandLink('#/'), el('a', { href: '#/docs', text: 'Documentación' })])]),
      el('main', { class: 'auth-main', id: 'main', tabindex: '-1' }, [card]),
      el('div'),
    ]));
  }

  // ---------------------------------------------------------------------------
  // Panel: marco
  // ---------------------------------------------------------------------------
  const DASH_NAV = [
    ['', 'Inicio', 'home'], ['pagos', 'Pagos', 'pay'], ['saldos', 'Saldos', 'wallet'],
    ['links', 'Links de pago', 'link'], ['metodos', 'Métodos de pago', 'card'], ['desarrolladores', 'Desarrolladores', 'code'], ['ajustes', 'Ajustes', 'sliders'],
  ];
  function kycInfo(m) {
    if (m.status === 'active') return { text: 'Cuenta activa', tone: 'ok' };
    if (m.status === 'restricted') return { text: 'Cuenta restringida', tone: 'bad' };
    if (m.status === 'closed') return { text: 'Cuenta cerrada', tone: '' };
    if (m.kyc_submitted_at) return { text: 'Activación en revisión', tone: 'note' };
    return { text: 'Activación pendiente', tone: 'warn', cta: true };
  }
  function dashShell(app, section) {
    const s = state.session;
    const m = s.merchant;
    const k = kycInfo(m);
    const side = el('aside', { class: 'side', id: 'side' }, [
      brandLink('#/dashboard'),
      el('div', { class: 'acct' }, [
        el('b', { text: m.business_name }),
        el('div', {}, [pill(k.text, k.tone)]),
        k.cta ? el('a', { href: '#/dashboard/ajustes', text: 'Activa tu cuenta' }) : null,
      ]),
      el('nav', { class: 'side-nav', 'aria-label': 'Panel' }, [el('ul', {}, DASH_NAV.map(([id, t, ic]) => el('li', {}, [
        el('a', { href: '#/dashboard' + (id ? '/' + id : ''), 'aria-current': id === section ? 'page' : false }, [icon(ic), t]),
      ])))]),
      el('div', { class: 'side-foot' }, [
        el('span', { class: 'who', text: s.user.email }),
        el('a', { class: 'link-btn', href: '#/', style: 'display:inline-flex;align-items:center;text-decoration:none', text: 'Ver el sitio' }),
        el('button', { class: 'link-btn', type: 'button', text: 'Cerrar sesión', onclick: logout }),
      ]),
    ]);
    const menu = el('button', { class: 'btn quiet sm', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'side' }, [icon('menu'), 'Menú']);
    menu.addEventListener('click', () => {
      const open = menu.getAttribute('aria-expanded') !== 'true';
      menu.setAttribute('aria-expanded', String(open));
      side.classList.toggle('open', open);
    });
    const main = el('main', { class: 'dash-main', id: 'main', tabindex: '-1' });
    app.replaceChildren(el('div', { class: 'dash' }, [
      el('div', { class: 'topbar' }, [brandLink('#/dashboard'), menu]),
      side,
      el('div', { class: 'dash-col' }, [
        s.livemode === false ? el('div', { class: 'testbar', role: 'note' }, [
          el('span', {}, [el('b', { text: 'Estás en modo de prueba:' }), ' los pagos no mueven dinero real']),
          s.other_mode_url ? el('a', { href: s.other_mode_url, text: 'Ir a producción' }) : null,
        ]) : null,
        main,
        IS_SERVER ? null : el('p', { class: 'demo-foot', text: 'Modo de demostración: datos de ejemplo. Nada de lo que hagas aquí mueve dinero ni se guarda al recargar.' }),
      ]),
    ]));
    return main;
  }
  async function logout() {
    try { await api.post('/logout'); } catch (_) { /* igual se sale */ }
    state.session = null;
    go('#/entrar');
  }
  function pageHead(title, sub, actions) {
    return el('div', { class: 'page-head' }, [
      el('div', {}, [el('h1', { tabindex: '-1', text: title }), sub ? el('p', { class: 'sub', text: sub }) : null]),
      actions ? el('div', { class: 'actions' }, actions) : null,
    ]);
  }
  async function load(main, tok, slot, fn) {
    try { const d = await fn(); return alive(tok) ? d : null; }
    catch (e) { if (alive(tok) && e.status !== 401) slot.replaceChildren(errorBanner(e, 'No pudimos cargar esta información')); return null; }
  }

  // ---------------------------------------------------------------------------
  // Panel: piezas comunes
  // ---------------------------------------------------------------------------
  function balanceCards(list) {
    const order = ['VES', 'USD', 'USDT'];
    const bs = list.slice().sort((a, b) => order.indexOf(a.currency) - order.indexOf(b.currency));
    return el('div', { class: 'grid-bal' }, bs.map((b) => el('section', { class: 'card bal', 'aria-label': 'Saldo en ' + (CUR_LONG[b.currency] || b.currency) }, [
      el('div', { class: 'cur' }, [el('span', { class: 'tag', text: SYMBOL[b.currency] }), 'Disponible']),
      el('div', { class: 'big num', text: fmt(b.available, b.currency) }),
      el('div', { class: 'row' }, [el('span', { text: 'Por recibir del banco' }), money(b.pending, b.currency)]),
    ])));
  }
  function paymentsTable(list, caption) {
    return el('div', { class: 'table-wrap flat' }, [el('table', { class: 'ptable' }, [
      el('caption', { class: 'sr-only', text: caption }),
      el('thead', {}, [el('tr', {}, [['Monto', 'r'], ['Cobro', 'r'], ['Método'], ['Estado'], ['Descripción'], ['Fecha']].map(([t, c]) => el('th', { scope: 'col', class: c || false, text: t })))]),
      el('tbody', {}, list.map((p) => {
        const sameCur = p.charge && p.charge.currency === p.currency && p.charge.amount === p.amount;
        return el('tr', {}, [
          el('td', { class: 'c-amount r' }, [el('a', { class: 'row-link num', href: '#/dashboard/pagos/' + p.id, text: fmt(p.amount, p.currency) })]),
          el('td', { class: 'c-charge r', 'data-label': p.charge && !sameCur ? 'Cobro' : false }, p.charge && !sameCur ? [money(p.charge.amount, p.charge.currency)] : []),
          el('td', { class: 'c-method', text: p.payment_method_type ? METHOD_NAMES[p.payment_method_type] || p.payment_method_type : '' }),
          el('td', { class: 'c-status' }, [statusPill(p.status)]),
          el('td', { class: 'c-desc' }, [el('span', { class: 'desc', text: p.description || 'Sin descripción', title: p.description || false })]),
          el('td', { class: 'c-date' }, [el('time', { class: 'when', datetime: p.created, text: fmtWhen(p.created) })]),
        ]);
      })),
    ])]);
  }

  // Barras de 14 días, una serie: sin leyenda; resumen en aria-label y tabla oculta
  function barChart(points, cur, width) {
    const W = Math.max(280, Math.round(width || 560)), H = 230, L = 56, R = 8, T = 12, B = 30;
    const vals = points.map((p) => Number(p.amount) / 10 ** EXP[cur]);
    const maxV = Math.max(0, ...vals);
    const nice = (v) => { if (v <= 0) return 1; const e = 10 ** Math.floor(Math.log10(v)); const f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; };
    const top = nice(maxV);
    const iw = W - L - R, ih = H - T - B;
    const slot = iw / points.length, bw = Math.min(28, slot - 6);
    const nf = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 0 });
    const grid = [0, 0.5, 1].map((f) => {
      const y = T + ih - ih * f;
      return svg('g', {}, [
        svg('line', { class: 'grid', x1: L, x2: W - R, y1: y, y2: y }),
        svg('text', { class: 'axis', x: L - 8, y: y + 4, 'text-anchor': 'end' }, [nf.format(top * f)]),
      ]);
    });
    const tip = el('div', { class: 'chart-tip', hidden: true });
    const bars = points.map((p, i) => {
      const v = vals[i];
      const h = v > 0 ? Math.max(2, (v / top) * ih) : 0;
      const x = L + slot * i + (slot - bw) / 2, y = T + ih - h;
      const r = Math.min(4, bw / 2, h);
      const d = h ? `M${x},${T + ih}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${T + ih}Z` : '';
      const date = new Date(p.date + 'T12:00:00');
      const g = svg('g', {}, [
        svg('rect', { class: 'hit', x: L + slot * i, y: T, width: slot, height: ih }),
        d ? svg('path', { class: 'bar', d }) : null,
        i % 2 === (points.length - 1) % 2 ? svg('text', { class: 'axis', x: L + slot * i + slot / 2, y: H - 10, 'text-anchor': 'middle' }, [String(date.getDate())]) : null,
      ]);
      const show = () => {
        g.classList.add('on');
        tip.replaceChildren(el('div', { text: DATE.format(date) }), el('div', {}, [el('span', { class: 'num', text: fmt(p.amount, cur) }), ' en ' + p.count + (p.count === 1 ? ' pago' : ' pagos')]));
        tip.hidden = false;
        tip.style.left = ((L + slot * i + slot / 2) / W * 100) + '%';
        tip.style.top = (Math.min(y, T + ih - 4) / H * 100) + '%';
      };
      const hide = () => { g.classList.remove('on'); tip.hidden = true; };
      g.addEventListener('pointerenter', show);
      g.addEventListener('pointerleave', hide);
      return g;
    });
    const total = points.reduce((s, p) => s + BigInt(p.amount), 0n);
    const count = points.reduce((s, p) => s + p.count, 0);
    let best = 0; vals.forEach((v, i) => { if (v > vals[best]) best = i; });
    const label = 'Cobros exitosos en ' + (CUR_LONG[cur] || cur) + ' de los últimos 14 días: ' + fmt(String(total), cur) + ' en ' + count + ' pagos.' +
      (maxV > 0 ? ' El día más alto fue el ' + DATE.format(new Date(points[best].date + 'T12:00:00')) + ' con ' + fmt(points[best].amount, cur) + '.' : '');
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label }, [...grid, ...bars]);
    const table = el('table', { class: 'sr-only' }, [
      el('caption', { text: 'Cobros exitosos por día en ' + (CUR_LONG[cur] || cur) }),
      el('thead', {}, [el('tr', {}, [el('th', { scope: 'col', text: 'Día' }), el('th', { scope: 'col', text: 'Monto' }), el('th', { scope: 'col', text: 'Pagos' })])]),
      el('tbody', {}, points.map((p) => el('tr', {}, [el('th', { scope: 'row', text: DATE.format(new Date(p.date + 'T12:00:00')) }), el('td', { text: fmt(p.amount, cur) }), el('td', { text: String(p.count) })]))),
    ]);
    return {
      node: el('div', { class: 'chart-box' }, [chart, tip, table]),
      sum: el('div', { class: 'chart-sum' }, [el('span', {}, ['Total: ', el('b', { class: 'num', text: fmt(String(total), cur) })]), el('span', {}, [el('b', { text: String(count) }), count === 1 ? ' pago' : ' pagos'])]),
    };
  }

  // ---------------------------------------------------------------------------
  // Panel: Inicio
  // ---------------------------------------------------------------------------
  const DASH = {};
  DASH[''] = async function home(main, r, tok) {
    setTitle('Inicio');
    const s = state.session;
    const slot = el('div', { class: 'skel-slot', style: 'display:grid;gap:16px' }, [el('div', { class: 'card' }, [skel(3)]), el('div', { class: 'card' }, [skel(6)])]);
    main.replaceChildren(pageHead('Inicio', 'Hola, ' + s.user.name.split(' ')[0] + '. Esto es lo que pasa en ' + s.merchant.business_name + '.', [
      el('a', { class: 'btn', href: '#/dashboard/pagos?nuevo=1', text: 'Crear pago' }),
    ]), slot);
    const d = await load(main, tok, slot, () => api.get('/overview'));
    if (!d) return;
    const out = [];
    if (d.needs_action > 0) {
      out.push(el('div', { class: 'callout' }, [
        el('span', {}, [el('b', { text: d.needs_action === 1 ? '1 pago espera' : d.needs_action + ' pagos esperan' }), ' la transferencia del cliente.']),
        el('a', { href: '#/dashboard/pagos?status=pending', text: 'Ver pendientes' }),
      ]));
    }
    out.push(balanceCards(d.balances));
    const curs = ['VES', 'USD', 'USDT'];
    const byCur = {};
    curs.forEach((c) => { byCur[c] = d.series.filter((p) => p.currency === c); });
    let cur = curs.slice().sort((a, b) => byCur[b].reduce((x, p) => x + p.count, 0) - byCur[a].reduce((x, p) => x + p.count, 0))[0];
    const chartSlot = el('div');
    const sumSlot = el('div');
    const segBtns = curs.map((c) => el('button', { type: 'button', 'aria-pressed': String(c === cur), text: SYMBOL[c] }));
    let lastW = 0;
    const draw = () => { lastW = chartSlot.clientWidth || 560; const ch = barChart(byCur[cur], cur, lastW); chartSlot.replaceChildren(ch.node); sumSlot.replaceChildren(ch.sum); };
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => { if (chartSlot.isConnected && Math.abs((chartSlot.clientWidth || 0) - lastW) > 8) draw(); });
      ro.observe(chartSlot);
      state.cleanups.push(() => ro.disconnect());
    }
    segBtns.forEach((b, i) => b.addEventListener('click', () => { cur = curs[i]; segBtns.forEach((x, j) => x.setAttribute('aria-pressed', String(j === i))); draw(); }));
    out.push(el('div', { class: 'grid-2' }, [
      el('section', { class: 'card', 'aria-labelledby': 'ch-h' }, [
        el('div', { class: 'card-head' }, [el('h2', { id: 'ch-h', text: 'Cobros de los últimos 14 días' }), el('div', { class: 'seg', role: 'group', 'aria-label': 'Moneda del gráfico' }, segBtns)]),
        sumSlot, chartSlot,
      ]),
      el('section', { class: 'card today', 'aria-labelledby': 'td-h' }, [
        el('h2', { id: 'td-h', text: 'Hoy' }),
        el('p', {}, [el('span', { class: 'big', text: String(d.today.count) }), ' ', d.today.count === 1 ? 'pago exitoso' : 'pagos exitosos']),
        d.today.volume.length ? el('ul', {}, d.today.volume.map((v) => el('li', {}, [el('span', { class: 'muted', text: 'Cobrado en ' + SYMBOL[v.currency] }), money(v.amount, v.currency)])))
          : el('p', { class: 'muted', text: 'Todavía no hay cobros hoy. Comparte un link de pago para empezar.' }),
      ]),
    ]));
    out.push(el('section', { class: 'card flush', 'aria-labelledby': 'rc-h' }, [
      el('div', { class: 'card-head' }, [el('h2', { id: 'rc-h', text: 'Pagos recientes' }), el('a', { href: '#/dashboard/pagos', text: 'Ver todos' })]),
      d.recent.length ? paymentsTable(d.recent, 'Pagos recientes') : emptyState('Aún no tienes pagos', 'Crea tu primer pago o un link de pago para compartirlo con tus clientes.', el('a', { class: 'btn', href: '#/dashboard/links', text: 'Crear un link de pago' })),
    ]));
    slot.replaceWith(...out);
    draw();
  };

  // ---------------------------------------------------------------------------
  // Panel: Pagos
  // ---------------------------------------------------------------------------
  DASH.pagos = function (main, r, tok) {
    if (r.parts[2]) return paymentDetail(main, r.parts[2], tok);
    setTitle('Pagos');
    const filters = [['all', 'Todos'], ['succeeded', 'Exitosos'], ['pending', 'Pendientes'], ['canceled', 'Cancelados']];
    let status = filters.some(([k]) => k === r.query.status) ? r.query.status : 'all';
    let q = r.query.q || '';
    let rows = [], hasMore = false, seq = 0;
    const createBtn = el('button', { class: 'btn', type: 'button', text: 'Crear pago', onclick: () => createPaymentDialog() });
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Filtrar por estado' });
    const fbtns = filters.map(([k, t]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(k === status), text: t });
      b.addEventListener('click', () => { status = k; fbtns.forEach((x, i) => x.setAttribute('aria-pressed', String(filters[i][0] === k))); setQuery({ status: k === 'all' ? null : k }); reload(); });
      return b;
    });
    seg.append(...fbtns);
    const search = el('input', { id: 'pay-q', type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: 'Buscar por id o descripción…', value: q });
    let deb = null;
    search.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { q = search.value.trim(); setQuery({ q: q || null }); reload(); }, 300); });
    const listSlot = el('div', { 'aria-live': 'polite', 'aria-busy': 'true' }, [el('div', { style: 'padding:20px' }, [skel(8)])]);
    const card = el('section', { class: 'card flush', 'aria-label': 'Lista de pagos' }, [listSlot]);
    main.replaceChildren(
      pageHead('Pagos', 'Todos los cobros de tu cuenta, en la moneda del precio y en la que se cobró.', [createBtn]),
      el('div', { class: 'toolbar' }, [seg, el('div', { class: 'search' }, [el('label', { for: 'pay-q', class: 'sr-only', text: 'Buscar pagos' }), icon('search'), search])]),
      card,
    );
    function draw() {
      listSlot.setAttribute('aria-busy', 'false');
      if (!rows.length) {
        listSlot.replaceChildren(q
          ? emptyState('Sin resultados', 'No hay pagos que coincidan con “' + q + '”. Prueba con otro texto o con el id completo.')
          : emptyState(status === 'all' ? 'Aún no tienes pagos' : 'No hay pagos en este estado', 'Crea un pago desde aquí o comparte un link de pago con tus clientes.', el('button', { class: 'btn ghost', type: 'button', text: 'Crear pago', onclick: () => createPaymentDialog() })));
        return;
      }
      const more = hasMore ? el('div', { class: 'more' }, [el('button', { class: 'btn quiet', type: 'button', text: 'Cargar más', onclick: (e) => loadMore(e.currentTarget) })]) : null;
      listSlot.replaceChildren(paymentsTable(rows, 'Pagos'), more);
    }
    async function reload() {
      const my = ++seq;
      listSlot.setAttribute('aria-busy', 'true');
      try {
        const d = await api.get('/payments', { status, q, limit: 25 });
        if (!alive(tok) || my !== seq) return;
        rows = d.data; hasMore = d.has_more; draw();
      } catch (e) { if (alive(tok) && my === seq) listSlot.replaceChildren(el('div', { style: 'padding:16px' }, [errorBanner(e, 'No pudimos cargar los pagos')])); }
    }
    async function loadMore(btn) {
      setBusy(btn, true, 'Cargando…');
      try {
        const d = await api.get('/payments', { status, q, limit: 25, starting_after: rows[rows.length - 1].id });
        if (!alive(tok)) return;
        const firstNew = rows.length;
        rows = rows.concat(d.data); hasMore = d.has_more; draw();
        const links = listSlot.querySelectorAll('a.row-link');
        if (links[firstNew]) links[firstNew].focus();
        announce(d.data.length + ' pagos más cargados');
      } catch (e) { setBusy(btn, false); toast(e.message); }
    }
    reload();
    if (r.query.nuevo) { setQuery({ nuevo: null }); setTimeout(() => createPaymentDialog(), 0); }
  };

  function amountField(prefix, defCur) {
    const amount = el('input', { id: prefix + '-amount', name: 'amount', inputmode: 'decimal', autocomplete: 'off', required: true, placeholder: '25,00…', translate: 'no' });
    const cur = el('select', { id: prefix + '-cur', name: 'currency', 'aria-label': 'Moneda' }, ['USD', 'VES', 'USDT'].map((c) => el('option', { value: c, text: SYMBOL[c], selected: c === defCur })));
    const f = field({ id: prefix + '-amount', label: 'Monto', input: amount, hint: 'Usa coma para los decimales, por ejemplo 1.250,50.', wrap: (i) => el('div', { class: 'amount-pair' }, [i, cur]) });
    return { f, amount, cur };
  }
  function createPaymentDialog() {
    openDialog({
      title: 'Crear pago',
      body: (dlg) => {
        const a = amountField('np', 'USD');
        const desc = field({ id: 'np-desc', label: 'Descripción (opcional)', attrs: { autocomplete: 'off', placeholder: 'Pedido #1044: 2 kg de café…', maxlength: '200' }, hint: 'La ve tu cliente en el checkout.' });
        const err = el('div');
        const btn = el('button', { class: 'btn', type: 'submit', text: 'Crear pago' });
        const form = el('form', { class: 'form', novalidate: true }, [a.f, desc, err, el('div', { class: 'dlg-actions' }, [el('button', { class: 'btn quiet', type: 'button', text: 'Cancelar', onclick: () => dlg.close() }), btn])]);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          err.replaceChildren();
          if (!validate([[a.amount, (v) => (parseAmount(v, a.cur.value) ? null : 'Escribe un monto mayor que cero, con hasta ' + EXP[a.cur.value] + ' decimales.')]])) return;
          setBusy(btn, true, 'Creando…');
          try {
            const res = await api.post('/payments', { amount: parseAmount(a.amount.value, a.cur.value), currency: a.cur.value, description: desc.querySelector('input').value.trim() || null });
            const p = res.payment;
            const urlCode = el('code', { translate: 'no', text: res.checkout_url });
            dlg.set('Pago creado', [
              el('p', {}, ['Comparte este enlace con tu cliente para que pague ', el('b', { class: 'num', text: fmt(p.amount, p.currency) }), '.']),
              el('div', { class: 'secret-box' }, [urlCode, copyButton(res.checkout_url, 'enlace de pago', urlCode)]),
              el('div', { class: 'dlg-actions' }, [
                el('a', { class: 'btn quiet', href: '#/dashboard/pagos/' + p.id, text: 'Ver el pago' }),
                el('button', { class: 'btn', type: 'button', text: 'Listo', onclick: () => dlg.close() }),
              ]),
            ]);
            dlg.dialog.querySelector('h2').focus();
            if (parseHash().path === '/dashboard/pagos') dlg.dialog.addEventListener('close', () => render(), { once: true });
          } catch (ex) { setBusy(btn, false); err.replaceChildren(errorBanner(ex, 'No pudimos crear el pago')); }
        });
        return [form];
      },
    });
  }

  async function paymentDetail(main, id, tok) {
    setTitle('Pago');
    const back = el('a', { class: 'back', href: '#/dashboard/pagos' }, [icon('back', 18), 'Pagos']);
    const h1 = el('h1', { tabindex: '-1', class: 'detail-amount' }, [el('span', { class: 'sr-only', text: 'Pago ' }), el('span', { text: 'Cargando…' })]);
    const slot = el('div', { style: 'display:grid;gap:16px' }, [el('div', { class: 'card' }, [skel(5)])]);
    main.replaceChildren(back, h1, slot);
    const p = await load(main, tok, slot, () => api.get('/payments/' + encodeURIComponent(id)));
    if (!p) { if (alive(tok)) h1.lastChild.textContent = 'No encontrado'; return; }
    drawDetail(main, p, tok, back);
  }
  function drawDetail(main, p, tok, back) {
    setTitle('Pago de ' + fmt(p.amount, p.currency));
    const h1 = el('h1', { tabindex: '-1', class: 'detail-amount' }, [el('span', { class: 'sr-only', text: 'Pago de ' }), el('span', { class: 'num', text: fmt(p.amount, p.currency) })]);
    const idCode = el('code', { translate: 'no', text: p.id });
    const actions = [];
    if (p.checkout_url && CANCELABLE.includes(p.status)) {
      const u = el('code', { translate: 'no', text: p.checkout_url, class: 'sr-only' });
      actions.push(el('a', { class: 'btn quiet', href: p.checkout_url, target: '_blank', rel: 'noopener' }, ['Abrir el checkout', el('span', { class: 'sr-only', text: ' (se abre en otra pestaña)' })]));
      const cb = copyButton(p.checkout_url, 'enlace de pago', u); cb.textContent = 'Copiar enlace'; cb.className = 'btn quiet';
      cb.addEventListener('click', () => setTimeout(() => { cb.textContent = 'Copiar enlace'; }, 2300));
      actions.push(cb);
    }
    if (CANCELABLE.includes(p.status)) {
      actions.push(el('button', { class: 'btn danger-ghost', type: 'button', text: 'Cancelar pago', onclick: () => confirmAction({
        title: '¿Cancelar este pago?', danger: true, label: 'Cancelar pago', busy: 'Cancelando…', cancel: 'No, volver',
        text: 'Tu cliente ya no podrá pagarlo. Si estaba por transferir, avísale para que no lo haga. Esta acción no se puede deshacer.',
        action: () => api.post('/payments/' + encodeURIComponent(p.id) + '/cancel'),
        done: (np) => { if (!alive(tok)) return; drawDetail(main, np, tok, back); toast('Pago cancelado'); main.querySelector('h1').focus(); },
      }) }));
    }
    const head = el('div', { class: 'page-head' }, [
      el('div', { style: 'display:grid;gap:10px' }, [h1, el('div', { class: 'detail-meta' }, [statusPill(p.status), el('span', { class: 'idline' }, [idCode, copyButton(p.id, 'id del pago', idCode)])])]),
      actions.length ? el('div', { class: 'actions' }, actions) : null,
    ]);

    // Desglose
    const ch = p.charge;
    const bd = el('section', { class: 'card', 'aria-labelledby': 'bd-h' }, [el('h2', { id: 'bd-h', text: 'Desglose' })]);
    if (ch) {
      const rows = [
        ['Precio', fmt(p.amount, p.currency)],
        ['Cobrado al cliente', fmt(ch.amount, ch.currency)],
        ['Comisión', fmt('-' + ch.fee, ch.currency)],
        ch.tax && ch.tax !== '0' ? ['IVA sobre la comisión', fmt('-' + ch.tax, ch.currency)] : null,
        ch.igtf && ch.igtf !== '0' ? ['IGTF retenido (3 %)', fmt('-' + ch.igtf, ch.currency)] : null,
      ].filter(Boolean);
      bd.append(el('dl', { class: 'dl' }, [
        ...rows.map(([k, v]) => el('div', {}, [el('dt', { text: k }), el('dd', {}, [el('span', { class: 'num', text: v })])])),
        el('div', { class: 'total' }, [el('dt', { text: 'Neto para ti' }), el('dd', {}, [money(ch.net, ch.currency)])]),
      ]));
      if (p.fx) {
        bd.append(el('div', { class: 'frozen' }, [el('div', {}, [
          el('span', {}, [(RATE_NAMES[p.fx.source] || 'Tasa') + ': ', el('span', { class: 'num', text: rateText(p) })]),
          el('small', { text: p.fx.frozen ? 'Congelada cuando el cliente confirmó' : 'Cotizada, vence ' + fmtWhen(p.fx.expires_at) }),
        ])]));
      }
    } else {
      bd.append(el('p', { class: 'muted', text: 'Tu cliente todavía no eligió cómo pagar. Cuando lo haga verás aquí el monto cobrado, la comisión y la tasa.' }));
    }
    // Detalles
    const det = [
      ['Método', p.payment_method_type ? METHOD_NAMES[p.payment_method_type] || p.payment_method_type : 'Sin elegir'],
      ['Descripción', p.description || 'Sin descripción'],
      ['Creado', fmtFull(p.created)],
      p.succeeded_at ? ['Cobrado', fmtFull(p.succeeded_at)] : null,
      p.expires_at && CANCELABLE.includes(p.status) ? ['Vence', fmtFull(p.expires_at)] : null,
      p.cancellation_reason ? ['Motivo de cancelación', { requested_by_merchant: 'Cancelado por el comercio', expired: 'Venció sin pago', abandoned: 'El cliente lo abandonó' }[p.cancellation_reason] || p.cancellation_reason] : null,
      p.last_payment_error ? ['Último rechazo', ERRORS[p.last_payment_error.code] || p.last_payment_error.message || p.last_payment_error.code] : null,
    ].filter(Boolean);
    const detCard = el('section', { class: 'card', 'aria-labelledby': 'dt-h' }, [el('h2', { id: 'dt-h', text: 'Detalles' }),
      el('dl', { class: 'dl' }, [
        ...det.map(([k, v]) => el('div', {}, [el('dt', { text: k }), el('dd', { text: v })])),
        p.payout ? el('div', {}, [el('dt', { text: 'Liquidación' }), el('dd', {}, [el('a', { href: '#/dashboard/saldos?payout=' + encodeURIComponent(p.payout.id), translate: 'no', text: p.payout.batch_code })])]) : null,
        ...Object.entries(p.metadata || {}).filter(([k]) => k !== 'description' && k !== 'source' && k !== 'payment_link').map(([k, v]) => el('div', {}, [el('dt', {}, [el('code', { translate: 'no', text: k })]), el('dd', { translate: 'no', text: typeof v === 'string' ? v : JSON.stringify(v) })])),
      ])]);
    const c = p.customer;
    const custRows = c ? [['Nombre', c.name], ['Correo', c.email], ['Teléfono', c.phone], ['Documento', c.document || c.id_number]].filter(([, v]) => v) : [];
    const custCard = el('section', { class: 'card', 'aria-labelledby': 'cu-h' }, [el('h2', { id: 'cu-h', text: 'Cliente' }),
      custRows.length ? el('dl', { class: 'dl' }, custRows.map(([k, v]) => el('div', {}, [el('dt', { text: k }), el('dd', { text: v })]))) : el('p', { class: 'muted', text: 'Sin datos del cliente. Puedes enviarlos en customer al crear el pago.' })]);
    // Historial
    const tl = el('section', { class: 'card', 'aria-labelledby': 'tl-h' }, [el('h2', { id: 'tl-h', text: 'Historial' }),
      el('ol', { class: 'timeline' }, (p.timeline || []).map((t) => el('li', {}, [el('div', { class: 'tl-body' }, [
        el('b', { text: TL_EVENTS[t.event] || (STATUS[t.to] ? STATUS[t.to][0] : t.event) }),
        el('span', {}, [(STATUS[t.to] ? 'Estado: ' + STATUS[t.to][0] + '. ' : '') + actorName(t.actor) + ', ', el('time', { datetime: t.created, text: fmtWhen(t.created) })]),
      ])])))]);
    const hadFocus = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected || main.contains(document.activeElement);
    main.replaceChildren(back, head, el('div', { class: 'grid-2' }, [el('div', { style: 'display:grid;gap:16px;min-width:0' }, [bd, detCard]), el('div', { style: 'display:grid;gap:16px;min-width:0' }, [tl, custCard])]));
    if (hadFocus && !document.querySelector('dialog[open]')) h1.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------
  // Panel: Saldos, liquidaciones y reglas
  // ---------------------------------------------------------------------------
  const PO_STATUS = { pending: ['Pendiente', 'warn'], sent: ['Enviada', 'note'], paid: ['Pagada', 'ok'], failed: ['Fallida', 'bad'] };
  function bankName(code) { const b = BANKS.find(([c]) => c === code); return b ? b[1] : code; }
  // Destino de liquidación: bank_ves {bank, account, holder}, bank_usd {bank, account, holder}, usdt_trc20 {address}
  function destText(d) {
    if (!d) return '';
    if (typeof d === 'string') return d;
    const tail = (x) => (x ? String(x).slice(-4) : '');
    const acct = d.account || d.account_number;
    if (d.type === 'bank_ves') return bankName(d.bank || d.bank_code) + (acct ? ', cuenta terminada en ' + tail(acct) : '');
    if (d.type === 'bank_usd') return (d.bank || d.bank_name || 'Banco') + (acct ? ', cuenta terminada en ' + tail(acct) : '');
    if (d.type === 'usdt_trc20') return 'USDT TRC-20 ' + String(d.address || '').slice(0, 5) + '…' + tail(d.address);
    return d.type || '';
  }
  function payoutRate(src, ins) {
    if (!ins.fx_rate) return '';
    if (src === 'VES') return '1 ' + SYMBOL[ins.currency] + ' = ' + fmtRate(ins.fx_rate) + ' Bs';
    if (ins.currency === 'VES') return '1 ' + SYMBOL[src] + ' = ' + fmtRate(ins.fx_rate) + ' Bs';
    return '1 USDT = ' + fmtRate(ins.fx_rate) + ' USD';
  }
  DASH.saldos = async function (main, r, tok) {
    setTitle('Saldos');
    const slot = el('div', { style: 'display:grid;gap:16px' }, [el('div', { class: 'card' }, [skel(3)]), el('div', { class: 'card' }, [skel(6)])]);
    main.replaceChildren(pageHead('Saldos y liquidaciones', 'Lo disponible se liquida en cada corte según tus reglas.'), slot);
    const [d, rr] = await Promise.all([
      load(main, tok, slot, () => api.get('/balances')),
      load(main, tok, slot, () => api.get('/settlement_rules')),
    ]);
    if (!d || !rr) return;
    const hl = r.query.payout;
    const pos = d.payouts.length ? d.payouts.map((po) => {
      const art = el('article', { class: 'payout' + (po.id === hl ? ' hl' : ''), id: 'po-' + po.id, 'aria-labelledby': 'poh-' + po.id, tabindex: po.id === hl ? '-1' : false }, [
        el('header', {}, [
          el('div', {}, [el('b', { id: 'poh-' + po.id, translate: 'no', text: po.batch_code }), el('div', { class: 'small muted', text: fmtFull(po.created) })]),
          el('div', { class: 'small' }, ['Lote de ', money(po.source_amount, po.source_currency)]),
        ]),
        el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Instrucciones del lote ' + po.batch_code }, [el('table', { class: 'stack-sm' }, [
          el('thead', {}, [el('tr', {}, [['Moneda'], ['Monto', 'r'], ['Tasa'], ['Spread'], ['Destino'], ['Estado']].map(([t, c]) => el('th', { scope: 'col', class: c || false, text: t })))]),
          el('tbody', {}, po.instructions.map((ins) => {
            const [st, tone] = PO_STATUS[ins.status] || [ins.status, ''];
            return el('tr', {}, [
              el('th', { scope: 'row', text: SYMBOL[ins.currency] || ins.currency }),
              el('td', { class: 'r', 'data-label': 'Monto' }, [money(ins.amount, ins.currency)]),
              el('td', { 'data-label': 'Tasa' }, [ins.fx_rate ? el('span', { class: 'num', text: payoutRate(po.source_currency, ins) }) : 'Sin conversión']),
              el('td', { 'data-label': 'Spread' }, [ins.fx_spread_bps ? el('span', { class: 'num', text: pct(ins.fx_spread_bps) }) : 'No aplica']),
              el('td', { 'data-label': 'Destino', translate: 'no', text: destText(ins.destination) }),
              el('td', {}, [pill(st, tone)]),
            ]);
          })),
        ])]),
      ]);
      return art;
    }) : [emptyState('Aún no hay liquidaciones', 'Cuando tengas saldo disponible, lo liquidaremos en el próximo corte según tus reglas.')];
    slot.replaceWith(
      balanceCards(d.balances),
      el('section', { class: 'card', 'aria-labelledby': 'po-h' }, [el('h2', { id: 'po-h', text: 'Liquidaciones' }), el('div', {}, pos)]),
      rulesEditor(rr.rules, tok),
    );
    if (hl) { const n = $('po-' + hl); if (n) requestAnimationFrame(() => { n.scrollIntoView({ block: 'center' }); n.focus({ preventScroll: true }); }); }
  };

  function rulesEditor(allRules, tok) {
    const SRC = ['VES', 'USD', 'USDT'];
    let src = 'VES';
    let rows = [];
    let rseq = 0;
    let sumEl = null;
    const load = () => { rows = (allRules[src] || []).map((x) => ({ k: ++rseq, cur: x.target_currency, pct: pct(x.bps).replace(' %', ''), dest: Object.assign({}, x.destination) })); if (!rows.length) rows = [blank('VES')]; };
    const blank = (cur) => ({ k: ++rseq, cur, pct: '', dest: cur === 'USDT' ? { type: 'usdt_trc20' } : { type: cur === 'VES' ? 'bank_ves' : 'bank_usd', bank: cur === 'VES' ? '0134' : '', holder: state.session.merchant.business_name } });
    const tabs = SRC.map((c) => el('button', { type: 'button', 'aria-pressed': String(c === src), text: 'Cobros en ' + SYMBOL[c] }));
    tabs.forEach((b, i) => b.addEventListener('click', () => { src = SRC[i]; tabs.forEach((x, j) => x.setAttribute('aria-pressed', String(j === i))); load(); draw(); }));
    const formSlot = el('div');
    const card = el('section', { class: 'card', 'aria-labelledby': 'ru-h' }, [
      el('div', { class: 'card-head' }, [el('h2', { id: 'ru-h', text: 'Reglas de liquidación' }), el('div', { class: 'seg', role: 'group', 'aria-label': 'Moneda de origen' }, tabs)]),
      el('p', { class: 'muted', text: 'Cómo repartimos tu saldo disponible en cada corte. Las porciones en otra moneda se convierten con la tasa del momento y un spread de cobertura que verás en cada liquidación.' }),
      formSlot,
    ]);
    function draw(errMsg) {
      const form = el('form', { class: 'form', novalidate: true, 'aria-label': 'Reglas para cobros en ' + SYMBOL[src] });
      const list = rows.map((row, idx) => {
        const n = idx + 1;
        const pre = 'r' + row.k;
        const curSel = el('select', { id: pre + '-cur' }, ['VES', 'USD', 'USDT'].map((c) => el('option', { value: c, text: SYMBOL[c], selected: c === row.cur })));
        curSel.addEventListener('change', () => { sync(form); const nr = blank(curSel.value); row.cur = nr.cur; row.dest = nr.dest; draw(); $(pre + '-cur').focus(); });
        const pctIn = el('input', { id: pre + '-pct', inputmode: 'decimal', autocomplete: 'off', value: row.pct, 'data-k': 'pct', placeholder: '60…' });
        pctIn.addEventListener('input', () => { row.pct = pctIn.value; updateSum(); });
        const destFields = [];
        const holderF = () => field({ id: pre + '-holder', label: 'Titular', attrs: { 'data-d': 'holder', autocomplete: 'off', value: row.dest.holder || '', placeholder: state.session.merchant.business_name + '…' } });
        if (row.cur === 'VES') {
          destFields.push(field({ id: pre + '-bank', label: 'Banco', input: el('select', { id: pre + '-bank', 'data-d': 'bank' }, BANKS.map(([c, nm]) => el('option', { value: c, text: nm + ' (' + c + ')', selected: c === (row.dest.bank || row.dest.bank_code) }))) }));
          destFields.push(field({ id: pre + '-acct', label: 'Número de cuenta', attrs: { 'data-d': 'account', inputmode: 'numeric', autocomplete: 'off', translate: 'no', value: row.dest.account || row.dest.account_number || '', placeholder: '20 dígitos…' } }));
          destFields.push(holderF());
        } else if (row.cur === 'USD') {
          destFields.push(field({ id: pre + '-bname', label: 'Banco', attrs: { 'data-d': 'bank', autocomplete: 'off', value: row.dest.bank || row.dest.bank_name || '', placeholder: 'Banesco Panamá…' } }));
          destFields.push(field({ id: pre + '-acct', label: 'Número de cuenta', attrs: { 'data-d': 'account', inputmode: 'numeric', autocomplete: 'off', translate: 'no', value: row.dest.account || row.dest.account_number || '', placeholder: '201800012345…' } }));
          destFields.push(holderF());
        } else {
          destFields.push(field({ id: pre + '-addr', label: 'Dirección USDT (TRC-20)', attrs: { 'data-d': 'address', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', translate: 'no', value: row.dest.address || '', placeholder: 'T…' } }));
        }
        const rm = rows.length > 1 ? el('button', { class: 'btn danger-ghost sm', type: 'button', text: 'Quitar', 'aria-label': 'Quitar el destino ' + n, onclick: () => { sync(form); rows.splice(idx, 1); draw(); const f = form.isConnected ? null : formSlot.querySelector('select'); if (f) f.focus(); } }) : null;
        return el('fieldset', { class: 'rule-row', 'data-row': String(idx) }, [
          el('legend', { class: 'sr-only', text: 'Destino ' + n }),
          field({ id: pre + '-cur', label: 'Recibes en', input: curSel }),
          field({ id: pre + '-pct', label: 'Porcentaje', input: pctIn, wrap: (i) => el('div', { class: 'pct' }, [i]) }),
          el('div', { class: 'dest' }, destFields),
          rm,
        ]);
      });
      const sumOut = el('span', { id: 'rules-sum' });
      sumEl = sumOut;
      const err = el('div', {}, errMsg ? [errorBanner({ message: errMsg }, 'Revisa la regla')] : []);
      const add = rows.length < 3 ? el('button', { class: 'btn ghost sm', type: 'button', text: 'Agregar destino', onclick: () => { sync(form); const used = rows.map((x) => x.cur); rows.push(blank(['VES', 'USDT', 'USD'].find((c) => !used.includes(c)) || 'USDT')); draw(); const ins = formSlot.querySelectorAll('[data-k=pct]'); ins[ins.length - 1].focus(); } }) : null;
      const save = el('button', { class: 'btn', type: 'submit', text: 'Guardar regla' });
      form.append(...list, el('div', { class: 'sum-line' }, [sumOut, add]), err, el('div', {}, [save]));
      form.addEventListener('submit', (e) => onSave(e, form, save, err));
      formSlot.replaceChildren(form);
      updateSum();
    }
    function sync(form) {
      form.querySelectorAll('fieldset[data-row]').forEach((fs) => {
        const row = rows[Number(fs.dataset.row)];
        if (!row) return;
        row.pct = fs.querySelector('[data-k=pct]').value;
        fs.querySelectorAll('[data-d]').forEach((i) => { row.dest[i.dataset.d] = i.value.trim(); });
      });
    }
    function total() { return rows.reduce((s, x) => s + (parseBps(x.pct) || 0), 0); }
    function updateSum() {
      const o = sumEl;
      if (!o) return;
      const t = total();
      o.className = t === 10000 ? 'total-ok' : 'total-bad';
      o.replaceChildren('Suma: ', el('span', { class: 'num', text: pct(t) }), t === 10000 ? '' : ' (debe ser 100 %)');
    }
    async function onSave(e, form, btn, err) {
      e.preventDefault();
      sync(form);
      err.replaceChildren();
      const checks = [];
      form.querySelectorAll('fieldset[data-row]').forEach((fs) => {
        checks.push([fs.querySelector('[data-k=pct]'), (v) => { const b = parseBps(v); return b && b > 0 && b <= 10000 ? null : 'Escribe un porcentaje entre 0,01 y 100.'; }]);
        fs.querySelectorAll('[data-d]').forEach((i) => {
          const k = i.dataset.d;
          if (k === 'account') checks.push([i, (v) => { const s = v.replace(/[\s-]/g, ''); return fs.querySelector('select[data-d=bank]') ? (/^\d{20}$/.test(s) ? null : 'La cuenta debe tener 20 dígitos.') : (/^\d{6,34}$/.test(s) ? null : 'Escribe el número de cuenta, solo dígitos.'); }]);
          if (k === 'bank') checks.push([i, (v) => (v.trim() ? null : 'Escribe el nombre del banco.')]);
          if (k === 'holder') checks.push([i, (v) => (v.trim().length >= 3 ? null : 'Escribe el titular de la cuenta.')]);
          if (k === 'address') checks.push([i, (v) => (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v.trim()) ? null : 'La dirección TRC-20 empieza con T y tiene 34 caracteres.')]);
        });
      });
      if (!validate(checks)) return;
      const t = total();
      if (t !== 10000) {
        err.replaceChildren(errorBanner({ message: 'Los porcentajes suman ' + pct(t) + '. Deben sumar exactamente 100 %.' }, 'Revisa la regla'));
        const first = form.querySelector('[data-k=pct]');
        rows.forEach((_, i) => { const inp = form.querySelectorAll('[data-k=pct]')[i]; inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-describedby', 'rules-sum'); });
        first.focus();
        return;
      }
      const body = { rules: rows.map((x) => {
        const d = { type: x.dest.type };
        const keep = d.type === 'usdt_trc20' ? ['address'] : ['bank', 'account', 'holder'];
        keep.forEach((k) => { if (x.dest[k] != null) d[k] = String(x.dest[k]).trim(); });
        if (d.account) d.account = d.account.replace(/[\s-]/g, '');
        return { target_currency: x.cur, bps: parseBps(x.pct), destination: d };
      }) };
      setBusy(btn, true, 'Guardando…');
      try {
        const res = await api.put('/settlement_rules/' + src, body);
        if (!alive(tok)) return;
        Object.assign(allRules, res.rules);
        load(); draw();
        toast('Regla para cobros en ' + SYMBOL[src] + ' guardada');
      } catch (ex) { setBusy(btn, false); err.replaceChildren(errorBanner(ex, 'No pudimos guardar la regla')); }
    }
    load(); draw();
    return card;
  }

  // ---------------------------------------------------------------------------
  // Panel: Links de pago
  // ---------------------------------------------------------------------------
  DASH.links = async function (main, r, tok) {
    setTitle('Links de pago');
    const slot = el('section', { class: 'card flush', 'aria-label': 'Links de pago' }, [el('div', { style: 'padding:20px' }, [skel(5)])]);
    const create = el('button', { class: 'btn', type: 'button', text: 'Crear link', onclick: () => createLinkDialog(refresh) });
    const note = el('div');
    main.replaceChildren(pageHead('Links de pago', 'Un enlace fijo para compartir por WhatsApp o Instagram. Cada vez que alguien lo abre se crea un pago nuevo.', [create]), note, slot);
    async function refresh(focusId) {
      const [d, caps] = await Promise.all([load(main, tok, slot, () => api.get('/payment_links')), api.get('/capabilities').catch(() => null)]);
      if (!d) return;
      const mod = caps && caps.data.find((c) => c.key === 'payment_links');
      const off = mod && mod.state !== 'active';
      create.disabled = !!off;
      note.replaceChildren(off ? el('div', { class: 'banner warn', role: 'note' }, [el('b', { text: 'Los links de pago están apagados' }), el('span', {}, ['Tus clientes no pueden abrirlos. ', el('a', { href: '#/dashboard/metodos', text: 'Enciéndelos en Métodos de pago' }), '.'])]) : '');
      if (!d.data.length) { slot.replaceChildren(emptyState('Aún no tienes links de pago', 'Crea uno con un monto fijo y compártelo con tus clientes: no necesitas programar.', el('button', { class: 'btn ghost', type: 'button', text: 'Crear link', onclick: () => createLinkDialog(refresh) }))); return; }
      slot.replaceChildren(el('div', { class: 'table-wrap', style: 'border:0;border-radius:0' }, [el('table', { class: 'stack-sm' }, [
        el('caption', { class: 'sr-only', text: 'Links de pago' }),
        el('thead', {}, [el('tr', {}, [['Descripción'], ['Monto', 'r'], ['Estado'], ['Pagos'], ['Creado'], ['Acciones', 'r']].map(([t, c]) => el('th', { scope: 'col', class: c || false, text: t })))]),
        el('tbody', {}, d.data.map((l) => {
          const u = el('code', { class: 'sr-only', translate: 'no', text: l.url });
          const cp = copyButton(l.url, 'enlace de ' + (l.description || 'pago'), u); cp.className = 'btn quiet sm'; cp.textContent = 'Copiar enlace';
          cp.addEventListener('click', () => setTimeout(() => { cp.textContent = 'Copiar enlace'; }, 2300));
          const tg = el('button', { class: 'btn sm ' + (l.active ? 'danger-ghost' : 'ghost'), type: 'button', id: 'tg-' + l.id, text: l.active ? 'Desactivar' : 'Activar', 'aria-label': (l.active ? 'Desactivar ' : 'Activar ') + (l.description || 'link') });
          tg.addEventListener('click', async () => {
            setBusy(tg, true, l.active ? 'Desactivando…' : 'Activando…');
            try { await api.post('/payment_links/' + encodeURIComponent(l.id) + '/' + (l.active ? 'deactivate' : 'activate')); toast(l.active ? 'Link desactivado' : 'Link activado'); await refresh(l.id); }
            catch (e) { setBusy(tg, false); toast(e.message); }
          });
          return el('tr', {}, [
            el('th', { scope: 'row' }, [l.description || 'Sin descripción', u,
              l.payment_method_types ? el('span', { class: 'muted cap-only', text: 'Solo ' + l.payment_method_types.map((t) => METHOD_NAMES[t] || t).join(', ') }) : null]),
            el('td', { class: 'r', 'data-label': 'Monto' }, [money(l.amount, l.currency)]),
            el('td', {}, [l.active ? pill('Activo', 'ok') : pill('Inactivo', '')]),
            el('td', { 'data-label': 'Pagos', text: l.succeeded_count + ' exitosos de ' + l.payments_count }),
            el('td', { 'data-label': 'Creado' }, [el('time', { datetime: l.created, text: fmtWhen(l.created, false) })]),
            el('td', { class: 'r' }, [el('div', { class: 'row-actions' }, [cp, tg])]),
          ]);
        })),
      ])]));
      if (focusId) { const b = $('tg-' + focusId); if (b) b.focus(); }
    }
    refresh();
  };
  async function createLinkDialog(after) {
    let active = [];
    try { active = (await api.get('/capabilities')).data.filter((c) => c.kind === 'method' && c.state === 'active'); }
    catch (_) { /* sin la lista, el link acepta todos los métodos activos */ }
    openDialog({
      title: 'Crear link de pago',
      body: (dlg) => {
        const a = amountField('nl', 'USD');
        const desc = field({ id: 'nl-desc', label: 'Qué vendes', attrs: { autocomplete: 'off', required: true, placeholder: '1 kg de café de Caripe…', maxlength: '200' }, hint: 'Lo ve tu cliente en el checkout.' });
        const allR = el('input', { type: 'radio', name: 'nl-m', id: 'nl-m-all', checked: true });
        const someR = el('input', { type: 'radio', name: 'nl-m', id: 'nl-m-some' });
        const boxes = active.map((c) => el('input', { type: 'checkbox', id: 'nl-m-' + c.key, value: c.key, checked: true }));
        const picks = el('div', { class: 'cap-picks', hidden: true }, active.map((c, i) => el('label', { class: 'check', for: boxes[i].id }, [boxes[i], c.name])));
        [allR, someR].forEach((x) => x.addEventListener('change', () => { picks.hidden = !someR.checked; }));
        const mErr = el('div', { id: 'nl-m-err' });
        const fs = active.length > 1 ? el('fieldset', { class: 'field', 'aria-describedby': 'nl-m-err' }, [
          el('legend', { text: 'Métodos que acepta' }),
          el('label', { class: 'check', for: 'nl-m-all' }, [allR, 'Todos los que tengas activos']),
          el('label', { class: 'check', for: 'nl-m-some' }, [someR, 'Solo algunos']),
          picks, mErr,
        ]) : null;
        const err = el('div');
        const btn = el('button', { class: 'btn', type: 'submit', text: 'Crear link' });
        const form = el('form', { class: 'form', novalidate: true }, [desc, a.f, fs, err, el('div', { class: 'dlg-actions' }, [el('button', { class: 'btn quiet', type: 'button', text: 'Cancelar', onclick: () => dlg.close() }), btn])]);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          err.replaceChildren(); mErr.replaceChildren();
          const di = desc.querySelector('input');
          if (!validate([[di, (v) => (v.trim() ? null : 'Describe lo que vendes.')], [a.amount, (v) => (parseAmount(v, a.cur.value) ? null : 'Escribe un monto mayor que cero, con hasta ' + EXP[a.cur.value] + ' decimales.')]])) return;
          const only = someR.checked ? boxes.filter((b) => b.checked).map((b) => b.value) : null;
          if (only && !only.length) { mErr.append(el('span', { class: 'err', text: 'Elige al menos un método.' })); boxes[0].focus(); return; }
          setBusy(btn, true, 'Creando…');
          try {
            const l = await api.post('/payment_links', { amount: parseAmount(a.amount.value, a.cur.value), currency: a.cur.value, description: di.value.trim(), payment_method_types: only });
            const u = el('code', { translate: 'no', text: l.url });
            dlg.set('Link creado', [
              el('p', {}, ['Comparte este enlace para cobrar ', el('b', { class: 'num', text: fmt(l.amount, l.currency) }), ' por “' + l.description + '”.']),
              el('div', { class: 'secret-box' }, [u, copyButton(l.url, 'enlace de pago', u)]),
              el('div', { class: 'dlg-actions' }, [el('button', { class: 'btn', type: 'button', text: 'Listo', onclick: () => dlg.close() })]),
            ]);
            dlg.dialog.querySelector('h2').focus();
            after();
          } catch (ex) { setBusy(btn, false); err.replaceChildren(errorBanner(ex, 'No pudimos crear el link')); }
        });
        return [form];
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Panel: Métodos de pago y módulos (interruptores por comercio)
  // ---------------------------------------------------------------------------
  const CAP_STATE = {
    active: ['Activo', 'ok'], disabled: ['Apagado', ''], pending_review: ['En revisión', 'note'],
    not_granted: ['No habilitado', 'warn'], blocked: ['Bloqueado por ' + BRAND.name, 'bad'], unavailable: ['No disponible por ahora', ''],
  };
  const CAP_HINT = {
    pending_review: 'Lo estamos revisando. Te avisaremos al correo de la cuenta.',
    not_granted: 'No viene incluido en tu cuenta. Pídelo y lo revisamos.',
    blocked: 'Escríbenos para saber por qué y cómo reactivarlo.',
    unavailable: 'Está apagado para todos los comercios mientras resolvemos una falla con el banco o el proveedor.',
  };
  const MODULE_INFO = {
    payment_links: 'Enlaces fijos para cobrar por WhatsApp o Instagram sin programar.',
    webhooks: 'Avisos firmados a tu servidor cuando cambia un pago. Apagado, los eventos se guardan pero no se envían.',
    settlement_usdt: 'Recibir parte de tus liquidaciones en USDT. Apagado, el corte espera hasta que cambies la regla de liquidación.',
    settlement_usd: 'Recibir parte de tus liquidaciones en dólares (Panamá o EE. UU.). Apagado, el corte espera hasta que cambies la regla.',
  };
  const canManage = () => ['owner', 'admin'].includes((state.session.user || {}).role || 'owner');
  function feeText(c) {
    let t = pct(c.fee_bps) + (c.fixed_usd && c.fixed_usd !== '0' ? ' + ' + fmt(c.fixed_usd, 'USD') : '') + (c.tax_bps ? ' + IVA' : '');
    if (c.igtf_bps) t += '. El pagador paga IGTF de ' + pct(c.igtf_bps);
    return 'Cobras en ' + SYMBOL[c.currency] + '. Comisión ' + t + (c.custom_pricing ? ' (precio acordado con tu cuenta)' : '') + '.';
  }
  DASH.metodos = function (main, r, tok) {
    setTitle('Métodos de pago');
    const methods = el('section', { class: 'card flush', 'aria-labelledby': 'cap-m-h' }, [el('div', { style: 'padding:20px' }, [skel(6)])]);
    const modules = el('section', { class: 'card flush', 'aria-labelledby': 'cap-x-h' }, [el('div', { style: 'padding:20px' }, [skel(2)])]);
    main.replaceChildren(...[
      pageHead('Métodos de pago', 'Elige qué métodos de pago ven tus clientes en el checkout y qué partes del producto usas.'),
      canManage() ? null : el('div', { class: 'banner info', role: 'note' }, [el('b', { text: 'Solo lectura' }), el('span', { text: 'Solo el dueño o un administrador de la cuenta puede cambiar estos interruptores.' })]),
      methods, modules,
    ].filter(Boolean));
    async function refresh(focusKey) {
      const d = await load(main, tok, methods, () => api.get('/capabilities'));
      if (!d) return;
      const list = (kind) => d.data.filter((c) => c.kind === kind);
      const activeCount = list('method').filter((c) => c.state === 'active').length;
      methods.replaceChildren(...[
        el('div', { class: 'card-head' }, [el('h2', { id: 'cap-m-h', text: 'Métodos de pago' }), el('span', { class: 'muted', text: activeCount + ' de ' + list('method').length + ' activos' })]),
        activeCount ? null : el('div', { class: 'banner warn', role: 'alert', style: 'margin:16px 20px 0' }, [el('b', { text: 'No tienes métodos activos' }), el('span', { text: 'Mientras no enciendas al menos uno no podrás crear pagos ni links.' })]),
        el('ul', { class: 'cap-list' }, list('method').map((c) => capRow(c, feeText(c)))),
      ].filter(Boolean));
      modules.replaceChildren(
        el('div', { class: 'card-head' }, [el('h2', { id: 'cap-x-h', text: 'Módulos' })]),
        el('ul', { class: 'cap-list' }, list('module').map((c) => capRow(c, MODULE_INFO[c.key] || ''))),
      );
      if (focusKey) { const b = $('cap-' + focusKey); if (b) b.focus(); }
    }
    function capRow(c, info) {
      const [label, tone] = CAP_STATE[c.state] || [c.state, ''];
      const descId = 'cap-d-' + c.key;
      let control = null;
      if (c.can_toggle) {
        const on = c.state === 'active';
        control = el('button', { class: 'switch', type: 'button', role: 'switch', id: 'cap-' + c.key, 'aria-checked': String(on), 'aria-label': c.name, 'aria-describedby': descId, disabled: !canManage() }, [el('span', { class: 'knob', 'aria-hidden': 'true' })]);
        control.addEventListener('click', async () => {
          control.disabled = true;
          try {
            const n = await api.put('/capabilities/' + encodeURIComponent(c.key), { enabled: !on });
            toast(n.name + (n.state === 'active' ? ' encendido' : ' apagado'));
            await refresh(c.key);
          } catch (e) { control.disabled = false; toast(e.message); }
        });
      } else if (c.can_request) {
        control = el('button', { class: 'btn ghost sm', type: 'button', id: 'cap-' + c.key, text: 'Solicitar', 'aria-label': 'Solicitar ' + c.name, disabled: !canManage() });
        control.addEventListener('click', async () => {
          setBusy(control, true, 'Enviando…');
          try { await api.post('/capabilities/' + encodeURIComponent(c.key) + '/request'); toast('Solicitud enviada'); await refresh(c.key); }
          catch (e) { setBusy(control, false); toast(e.message); }
        });
      }
      return el('li', { class: 'cap-row' }, [
        el('div', { class: 'cap-text' }, [
          el('div', { class: 'cap-name' }, [el('b', { text: c.name }), pill(label, tone)]),
          el('p', { class: 'muted', id: descId, text: [info, CAP_HINT[c.state]].filter(Boolean).join(' ') }),
        ]),
        control,
      ]);
    }
    refresh();
  };

  // ---------------------------------------------------------------------------
  // Panel: Desarrolladores (llaves, webhooks, eventos)
  // ---------------------------------------------------------------------------
  function tabs(defs, current, onChange) {
    const list = el('div', { role: 'tablist', 'aria-label': 'Secciones' });
    const panels = [];
    const btns = defs.map(([id, label], i) => {
      const b = el('button', { role: 'tab', type: 'button', id: 'tab-' + id, 'aria-controls': 'panel-' + id, 'aria-selected': String(id === current), tabindex: id === current ? '0' : '-1', text: label });
      const p = el('div', { role: 'tabpanel', id: 'panel-' + id, 'aria-labelledby': 'tab-' + id, tabindex: '0', hidden: id !== current });
      panels.push(p);
      b.addEventListener('click', () => select(i));
      b.addEventListener('keydown', (e) => {
        const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (k) { e.preventDefault(); select((i + k + defs.length) % defs.length, true); }
        if (e.key === 'Home') { e.preventDefault(); select(0, true); }
        if (e.key === 'End') { e.preventDefault(); select(defs.length - 1, true); }
      });
      return b;
    });
    function select(i, focus) {
      btns.forEach((b, j) => { b.setAttribute('aria-selected', String(i === j)); b.tabIndex = i === j ? 0 : -1; panels[j].hidden = i !== j; });
      if (focus) btns[i].focus();
      onChange(defs[i][0], panels[i]);
    }
    list.append(...btns);
    return { list, panels, start: () => select(Math.max(0, defs.findIndex(([id]) => id === current))) };
  }
  DASH.desarrolladores = function (main, r, tok) {
    setTitle('Desarrolladores');
    const defs = [['llaves', 'Llaves API'], ['webhooks', 'Webhooks'], ['eventos', 'Eventos']];
    const current = defs.some(([id]) => id === r.query.tab) ? r.query.tab : 'llaves';
    const loaded = {};
    const t = tabs(defs, current, (id, panel) => {
      setQuery({ tab: id === 'llaves' ? null : id });
      if (loaded[id]) return;
      loaded[id] = true;
      ({ llaves: keysPanel, webhooks: hooksPanel, eventos: eventsPanel })[id](panel, tok);
    });
    main.replaceChildren(pageHead('Desarrolladores', 'Llaves para la API, endpoints de webhooks y el registro de eventos enviados.', [el('a', { class: 'btn quiet', href: '#/docs', text: 'Documentación' })]), t.list, ...t.panels);
    t.start();
  };
  function showSecretDialog(title, key, what) {
    openDialog({
      title,
      focusTitle: true,
      body: (dlg) => {
        const c = el('code', { translate: 'no', text: key });
        return [
          el('div', { class: 'banner warn', role: 'note' }, [el('b', { text: 'Cópiala ahora.' }), el('span', { text: 'Por seguridad no volveremos a mostrar esta ' + what + '. Guárdala en las variables de entorno de tu servidor, nunca en el código del navegador.' })]),
          el('div', { class: 'secret-box' }, [c, copyButton(key, what, c)]),
          el('div', { class: 'dlg-actions' }, [el('button', { class: 'btn', type: 'button', text: 'Ya la guardé', onclick: () => dlg.close() })]),
        ];
      },
    });
  }
  async function keysPanel(panel, tok) {
    const listSlot = el('div', {}, [skel(4)]);
    const create = el('button', { class: 'btn', type: 'button', text: 'Crear llave secreta' });
    panel.replaceChildren(
      el('div', { class: 'toolbar' }, [el('p', { class: 'muted', style: 'max-width:46em', text: state.session.livemode ? 'Llaves de producción: mueven dinero real.' : 'Llaves de prueba: sirven solo en el sandbox y no mueven dinero real.' }), create]),
      listSlot,
    );
    create.addEventListener('click', async () => {
      setBusy(create, true, 'Creando…');
      try { const k = await api.post('/api_keys', { kind: 'secret' }); setBusy(create, false); showSecretDialog('Tu nueva llave secreta', k.key, 'llave secreta'); refresh(); }
      catch (e) { setBusy(create, false); toast(e.message); }
    });
    async function refresh() {
      let d;
      try { d = await api.get('/api_keys'); } catch (e) { listSlot.replaceChildren(errorBanner(e, 'No pudimos cargar las llaves')); return; }
      if (!alive(tok)) return;
      const keys = d.data.slice().sort((a, b) => (a.active === b.active ? (a.kind === b.kind ? 0 : a.kind === 'publishable' ? -1 : 1) : a.active ? -1 : 1));
      listSlot.replaceChildren(el('div', { class: 'table-wrap' }, [el('table', { class: 'stack-sm' }, [
        el('caption', { class: 'sr-only', text: 'Llaves API' }),
        el('thead', {}, [el('tr', {}, ['Tipo', 'Llave', 'Último uso', 'Creada', 'Acciones'].map((x) => el('th', { scope: 'col', text: x })))]),
        el('tbody', {}, keys.map((k) => {
          const shown = k.key ? el('code', { translate: 'no', text: k.key }) : el('code', { translate: 'no', 'aria-label': 'Llave secreta que empieza con ' + k.prefix, text: k.prefix + '••••••••' });
          const acts = [];
          if (k.active) {
            acts.push(el('button', { class: 'btn quiet sm', type: 'button', text: 'Rotar', 'aria-label': 'Rotar la llave ' + k.prefix, onclick: () => confirmAction({
              title: '¿Rotar esta llave?', label: 'Rotar llave', busy: 'Rotando…',
              text: 'Creamos una llave nueva y revocamos esta de inmediato. Lo que la use dejará de funcionar hasta que pongas la nueva.',
              action: () => api.post('/api_keys/' + encodeURIComponent(k.id) + '/roll'),
              done: (res) => { refresh(); if (k.kind === 'secret') showSecretDialog('Tu nueva llave secreta', res.key, 'llave secreta'); else toast('Llave publicable rotada'); },
            }) }));
            acts.push(el('button', { class: 'btn danger-ghost sm', type: 'button', text: 'Revocar', 'aria-label': 'Revocar la llave ' + k.prefix, onclick: () => confirmAction({
              title: '¿Revocar esta llave?', label: 'Revocar llave', busy: 'Revocando…', danger: true,
              text: 'La llave ' + k.prefix + '… dejará de funcionar de inmediato. Esta acción no se puede deshacer.',
              action: () => api.post('/api_keys/' + encodeURIComponent(k.id) + '/revoke'),
              done: () => { refresh(); toast('Llave revocada'); },
            }) }));
          }
          return el('tr', {}, [
            el('th', { scope: 'row' }, [k.kind === 'secret' ? 'Secreta' : 'Publicable', ' ', k.active ? null : pill('Revocada', 'bad')]),
            el('td', {}, [el('div', { class: 'keyval' }, [shown, k.key && k.active ? copyButton(k.key, 'llave publicable', shown) : null])]),
            el('td', { 'data-label': 'Último uso', text: k.last_used_at ? fmtWhen(k.last_used_at) : 'Nunca' }),
            el('td', { 'data-label': 'Creada', text: fmtWhen(k.created, false) }),
            el('td', {}, acts.length ? [el('div', { class: 'row-actions' }, acts)] : [el('span', { class: 'muted small', text: k.revoked_at ? 'Revocada ' + fmtWhen(k.revoked_at, false) : '' })]),
          ]);
        })),
      ])]));
    }
    refresh();
  }
  async function hooksPanel(panel, tok) {
    const listSlot = el('div', { class: 'card' }, [skel(4)]);
    const add = el('button', { class: 'btn', type: 'button', text: 'Agregar endpoint', onclick: () => addEndpointDialog(refresh) });
    panel.replaceChildren(el('div', { class: 'toolbar' }, [el('p', { class: 'muted', style: 'max-width:46em', text: 'Te avisamos por HTTPS cuando cambia un pago. Verifica la firma con el secreto de cada endpoint.' }), add]), listSlot);
    async function refresh() {
      let d;
      try { d = await api.get('/webhooks'); } catch (e) { listSlot.replaceChildren(errorBanner(e, 'No pudimos cargar los webhooks')); return; }
      if (!alive(tok)) return;
      if (!d.data.length) { listSlot.replaceChildren(emptyState('Aún no tienes endpoints', 'Agrega la URL de tu servidor para recibir los pagos exitosos al instante.', el('button', { class: 'btn ghost', type: 'button', text: 'Agregar endpoint', onclick: () => addEndpointDialog(refresh) }))); return; }
      listSlot.replaceChildren(...d.data.map((ep) => {
        const secretSlot = el('div');
        const reveal = el('button', { class: 'btn quiet sm', type: 'button', text: 'Revelar secreto' });
        reveal.addEventListener('click', async () => {
          setBusy(reveal, true, 'Cargando…');
          try {
            const s = await api.post('/webhooks/' + encodeURIComponent(ep.id) + '/reveal');
            const c = el('code', { translate: 'no', text: s.secret });
            const hide = el('button', { class: 'btn quiet sm', type: 'button', text: 'Ocultar', onclick: () => { secretSlot.replaceChildren(); reveal.hidden = false; setBusy(reveal, false); reveal.focus(); } });
            reveal.hidden = true;
            secretSlot.replaceChildren(el('div', { class: 'secret-box' }, [c, copyButton(s.secret, 'secreto de firma', c), hide]));
            hide.focus();
          } catch (e) { setBusy(reveal, false); toast(e.message); }
        });
        const test = el('button', { class: 'btn quiet sm', type: 'button', text: 'Enviar evento de prueba' });
        test.addEventListener('click', async () => {
          setBusy(test, true, 'Enviando…');
          try { const res = await api.post('/webhooks/' + encodeURIComponent(ep.id) + '/test'); setBusy(test, false); toast('Evento de prueba enviado: ' + res.event_id); }
          catch (e) { setBusy(test, false); toast(e.message); }
        });
        const on = ep.status === 'enabled';
        const tg = el('button', { class: 'btn sm ' + (on ? 'danger-ghost' : 'ghost'), type: 'button', text: on ? 'Desactivar' : 'Activar' });
        tg.addEventListener('click', async () => {
          setBusy(tg, true, on ? 'Desactivando…' : 'Activando…');
          try { await api.post('/webhooks/' + encodeURIComponent(ep.id) + '/' + (on ? 'disable' : 'enable')); toast(on ? 'Endpoint desactivado' : 'Endpoint activado'); refresh(); }
          catch (e) { setBusy(tg, false); toast(e.message); }
        });
        const ld = ep.last_delivery;
        return el('article', { class: 'endpoint', 'aria-label': 'Endpoint ' + ep.url }, [
          el('div', { class: 'card-head' }, [el('span', { class: 'url', translate: 'no', text: ep.url }), on ? pill('Activo', 'ok') : pill('Desactivado', '')]),
          el('ul', { class: 'evs', 'aria-label': 'Eventos suscritos' }, ep.enabled_events.map((x) => el('li', { translate: 'no', text: x }))),
          el('p', { class: 'small muted', text: ld ? 'Última entrega: ' + (ld.status === 'succeeded' ? 'exitosa' : ld.status === 'failed' ? 'fallida' : 'pendiente') + (ld.status_code ? ' (HTTP ' + ld.status_code + ')' : '') + ', ' + fmtWhen(ld.at).replace(/\.$/, '') + '.' : 'Todavía no hemos enviado eventos a este endpoint.' }),
          secretSlot,
          el('div', { class: 'row-actions', style: 'justify-content:flex-start' }, [reveal, test, tg]),
        ]);
      }));
    }
    refresh();
  }
  function addEndpointDialog(after) {
    openDialog({
      title: 'Agregar endpoint',
      body: (dlg) => {
        const url = field({ id: 'wh-url', label: 'URL del endpoint', attrs: { type: 'url', inputmode: 'url', autocomplete: 'url', spellcheck: 'false', autocapitalize: 'off', translate: 'no', placeholder: 'https://tu-sitio.com/webhooks…' }, hint: 'Debe empezar con https:// y responder 2xx en menos de 10 segundos.' });
        const types = state.session.event_types || Object.keys(EVENT_INFO);
        const boxes = types.map((t) => el('input', { type: 'checkbox', id: 'ev-' + t.replace(/\./g, '-'), value: t, checked: t === 'payment_intent.succeeded' }));
        const all = el('input', { type: 'checkbox', id: 'ev-all' });
        all.addEventListener('change', () => boxes.forEach((b) => { b.checked = all.checked; }));
        boxes.forEach((b) => b.addEventListener('change', () => { all.checked = boxes.every((x) => x.checked); }));
        const evErr = el('div', { id: 'ev-err' });
        const fs = el('fieldset', { class: 'field', 'aria-describedby': 'ev-err' }, [
          el('legend', { text: 'Eventos' }),
          el('label', { class: 'check', for: 'ev-all' }, [all, 'Todos los eventos']),
          ...types.map((t, i) => el('label', { class: 'check', for: boxes[i].id }, [boxes[i], el('code', { translate: 'no', text: t })])),
          evErr,
        ]);
        const err = el('div');
        const btn = el('button', { class: 'btn', type: 'submit', text: 'Agregar endpoint' });
        const form = el('form', { class: 'form', novalidate: true }, [url, fs, err, el('div', { class: 'dlg-actions' }, [el('button', { class: 'btn quiet', type: 'button', text: 'Cancelar', onclick: () => dlg.close() }), btn])]);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          err.replaceChildren(); evErr.replaceChildren();
          const ui = url.querySelector('input');
          if (!validate([[ui, (v) => (/^https:\/\/[^\s/]+\.[^\s]+$/.test(v.trim()) ? null : 'Escribe una URL que empiece con https://, como https://tu-sitio.com/webhooks.')]])) return;
          const evs = boxes.filter((b) => b.checked).map((b) => b.value);
          if (!evs.length) { evErr.append(el('span', { class: 'err', text: 'Elige al menos un evento.' })); boxes[0].focus(); return; }
          setBusy(btn, true, 'Agregando…');
          try {
            const ep = await api.post('/webhooks', { url: ui.value.trim(), enabled_events: evs });
            after();
            const c = el('code', { translate: 'no', text: ep.secret });
            dlg.set('Endpoint agregado', [
              el('p', { text: 'Usa este secreto para verificar la cabecera Webhook-Signature. Puedes volver a verlo con “Revelar secreto”.' }),
              el('div', { class: 'secret-box' }, [c, copyButton(ep.secret, 'secreto de firma', c)]),
              el('div', { class: 'dlg-actions' }, [el('button', { class: 'btn', type: 'button', text: 'Listo', onclick: () => dlg.close() })]),
            ]);
            dlg.dialog.querySelector('h2').focus();
          } catch (ex) { setBusy(btn, false); err.replaceChildren(errorBanner(ex, 'No pudimos agregar el endpoint')); }
        });
        return [form];
      },
    });
  }
  function deliverySummary(ev) {
    const d = ev.deliveries || [];
    if (!d.length) return pill('Sin endpoints', '');
    if (d.some((x) => x.status === 'failed')) return pill('Falló', 'bad');
    if (d.some((x) => x.status === 'pending')) return pill('Pendiente', 'note');
    return pill('Entregado', 'ok');
  }
  async function eventsPanel(panel, tok) {
    let rows = [], hasMore = false;
    const slot = el('div', { class: 'card flush' }, [el('div', { style: 'padding:20px' }, [skel(6)])]);
    panel.replaceChildren(slot);
    function draw(focusIdx) {
      if (!rows.length) { slot.replaceChildren(emptyState('Todavía no hay eventos', 'Cuando crees o cobres un pago verás aquí cada evento y su entrega a tus endpoints.')); return; }
      const t = el('div', { class: 'table-wrap', style: 'border:0;border-radius:0' }, [el('table', { class: 'stack-sm' }, [
        el('caption', { class: 'sr-only', text: 'Eventos' }),
        el('thead', {}, [el('tr', {}, ['Evento', 'Objeto', 'Entrega', 'Fecha', 'Detalle'].map((x) => el('th', { scope: 'col', text: x })))]),
        el('tbody', {}, rows.map((ev) => el('tr', {}, [
          el('th', { scope: 'row' }, [el('code', { translate: 'no', text: ev.type })]),
          el('td', { 'data-label': 'Objeto' }, [el('code', { translate: 'no', text: ev.object_id })]),
          el('td', {}, [deliverySummary(ev)]),
          el('td', { 'data-label': 'Fecha' }, [el('time', { datetime: ev.created, text: fmtWhen(ev.created) })]),
          el('td', {}, [el('button', { class: 'btn quiet sm ev-open', type: 'button', text: 'Ver', 'aria-label': 'Ver el evento ' + ev.type + ' ' + ev.id, onclick: () => eventDrawer(ev.id, reload) })]),
        ]))),
      ])]);
      const more = hasMore ? el('div', { class: 'more' }, [el('button', { class: 'btn quiet', type: 'button', text: 'Cargar más', onclick: async (e) => {
        const b = e.currentTarget; setBusy(b, true, 'Cargando…');
        try { const d = await api.get('/events', { limit: 20, starting_after: rows[rows.length - 1].id }); const n = rows.length; rows = rows.concat(d.data); hasMore = d.has_more; draw(n); }
        catch (ex) { setBusy(b, false); toast(ex.message); }
      } })]) : null;
      slot.replaceChildren(t, more);
      if (focusIdx != null) { const b = slot.querySelectorAll('.ev-open')[focusIdx]; if (b) b.focus(); }
    }
    async function reload() {
      try { const d = await api.get('/events', { limit: 20 }); if (!alive(tok)) return; rows = d.data; hasMore = d.has_more; draw(); }
      catch (e) { slot.replaceChildren(el('div', { style: 'padding:16px' }, [errorBanner(e, 'No pudimos cargar los eventos')])); }
    }
    reload();
  }
  function eventDrawer(id, onChange) {
    openDialog({
      title: 'Evento',
      drawer: true,
      focusTitle: true,
      body: (dlg) => {
        const fill = async () => {
          try {
            const ev = await api.get('/events/' + encodeURIComponent(id));
            const resend = el('button', { class: 'btn quiet', type: 'button', text: 'Reenviar a los endpoints' });
            resend.addEventListener('click', async () => {
              setBusy(resend, true, 'Reenviando…');
              try { await api.post('/events/' + encodeURIComponent(id) + '/resend'); toast('Evento reenviado'); onChange(); await fill(); dlg.dialog.querySelector('h2').focus(); }
              catch (e) { setBusy(resend, false); toast(e.message); }
            });
            dlg.set(ev.type, [
              el('dl', { class: 'dl' }, [
                el('div', {}, [el('dt', { text: 'Id' }), el('dd', {}, [el('code', { translate: 'no', text: ev.id })])]),
                el('div', {}, [el('dt', { text: 'Objeto' }), el('dd', {}, [ev.object_id && ev.object_id.startsWith('pi_') ? el('a', { href: '#/dashboard/pagos/' + ev.object_id, translate: 'no', text: ev.object_id }) : el('code', { translate: 'no', text: ev.object_id })])]),
                el('div', {}, [el('dt', { text: 'Fecha' }), el('dd', { text: fmtFull(ev.created) })]),
              ]),
              el('h3', { text: 'Entregas', style: 'font-size:17px' }),
              ev.deliveries.length ? el('ul', { style: 'list-style:none;padding:0;margin:0;display:grid;gap:10px' }, ev.deliveries.map((d) => el('li', { class: 'card', style: 'padding:14px;gap:6px' }, [
                el('div', { class: 'card-head' }, [el('span', { class: 'mono small', translate: 'no', text: d.url, style: 'overflow-wrap:anywhere' }), pill(d.status === 'succeeded' ? 'Entregado' : d.status === 'failed' ? 'Falló' : 'Pendiente', d.status === 'succeeded' ? 'ok' : d.status === 'failed' ? 'bad' : 'note')]),
                el('span', { class: 'small muted', text: d.attempts + (d.attempts === 1 ? ' intento' : ' intentos') + (d.last_status_code ? ', última respuesta HTTP ' + d.last_status_code : '') + (d.next_attempt_at ? '. Próximo reintento ' + fmtWhen(d.next_attempt_at).replace(/\.$/, '') : '') + '.' }),
              ]))) : el('p', { class: 'muted', text: 'Ningún endpoint estaba suscrito a este evento.' }),
              ev.deliveries.length ? el('div', {}, [resend]) : null,
              el('h3', { text: 'Contenido', style: 'font-size:17px' }),
              codeBlock(JSON.stringify(ev.payload, null, 2), 'JSON'),
            ]);
          } catch (e) { dlg.set('Evento', [errorBanner(e, 'No pudimos cargar el evento')]); }
        };
        fill();
        return [loading('Cargando el evento…')];
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Panel: Ajustes
  // ---------------------------------------------------------------------------
  DASH.ajustes = function (main, r, tok) {
    setTitle('Ajustes');
    const s = state.session, m = s.merchant;
    // Perfil
    const nameF = field({ id: 'biz-name', label: 'Nombre del negocio', attrs: { autocomplete: 'organization', value: m.business_name, required: true }, hint: 'Lo ven tus clientes en el checkout.' });
    const rifF = field({ id: 'biz-rif', label: 'RIF', attrs: { readonly: true, value: m.rif, translate: 'no' }, hint: 'El RIF no se puede cambiar desde el panel.' });
    const emailF = field({ id: 'biz-email', label: 'Correo de la cuenta', attrs: { readonly: true, value: s.user.email, translate: 'no' } });
    const perr = el('div', { class: 'full' });
    const psave = el('button', { class: 'btn', type: 'submit', text: 'Guardar cambios' });
    const pform = el('form', { class: 'form-grid', novalidate: true }, [nameF, rifF, emailF, perr, el('div', { class: 'full' }, [psave])]);
    pform.addEventListener('submit', async (e) => {
      e.preventDefault();
      perr.replaceChildren();
      const ni = nameF.querySelector('input');
      if (!validate([[ni, (v) => (v.trim() ? null : 'Escribe el nombre del negocio.')]])) return;
      setBusy(psave, true, 'Guardando…');
      try {
        const nm = await api.put('/account', { business_name: ni.value.trim() });
        state.session.merchant = nm;
        toast('Cambios guardados');
        if (alive(tok)) { const b = document.querySelector('.acct b'); if (b) b.textContent = nm.business_name; }
        setBusy(psave, false);
      } catch (ex) { setBusy(psave, false); perr.replaceChildren(errorBanner(ex, 'No pudimos guardar')); }
    });
    const kyc = el('section', { class: 'card', id: 'activar', 'aria-labelledby': 'kyc-h' });
    drawKyc(kyc, tok);
    main.replaceChildren(
      pageHead('Ajustes', 'Datos de tu negocio y activación de la cuenta.'),
      el('section', { class: 'card', 'aria-labelledby': 'pf-h' }, [el('h2', { id: 'pf-h', text: 'Perfil del negocio' }), pform]),
      kyc,
    );
  };
  function drawKyc(card, tok) {
    const m = state.session.merchant;
    const k = kycInfo(m);
    const head = el('div', { class: 'card-head' }, [el('h2', { id: 'kyc-h', text: 'Activación de la cuenta' }), pill(k.text, k.tone)]);
    if (m.status === 'active') { card.replaceChildren(head, el('p', { text: 'Tu cuenta está activa. Ya puedes crear llaves de producción y cobrar de verdad.' })); return; }
    if (m.status !== 'pending_kyc') { card.replaceChildren(head, el('p', { text: 'Tu cuenta tiene restricciones. Revisa el correo que te enviamos con los pasos a seguir.' })); return; }
    if (m.kyc_submitted_at) {
      card.replaceChildren(head, el('p', { text: 'Recibimos los datos de tu empresa el ' + fmtFull(m.kyc_submitted_at).replace(/\.$/, '') + '. Te escribiremos al correo de la cuenta cuando terminemos la revisión. Mientras tanto puedes seguir probando en modo de prueba.' }));
      return;
    }
    const f = (id, label, attrs, hint, full) => field({ id, label, attrs: Object.assign({ autocomplete: 'off' }, attrs), hint, full });
    const legal = f('k-legal', 'Razón social', { autocomplete: 'organization', placeholder: 'Inversiones El Ávila, C.A.…' }, 'Tal como aparece en el RIF.', true);
    const rep = f('k-rep', 'Representante legal', { autocomplete: 'name', placeholder: 'María Fernández…' });
    const repId = f('k-repid', 'Cédula del representante', { placeholder: 'V-12345678…', translate: 'no', autocapitalize: 'characters' });
    const phone = f('k-phone', 'Teléfono de contacto', { type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '0414-1234567…' });
    const addr = field({ id: 'k-addr', label: 'Dirección fiscal', tag: 'textarea', attrs: { autocomplete: 'street-address', rows: '3', placeholder: 'Av. Principal de Los Palos Grandes, Edif. …' }, full: true });
    const bank = field({ id: 'k-bank', label: 'Banco para tus liquidaciones en Bs', input: el('select', { id: 'k-bank' }, [el('option', { value: '', text: 'Elige un banco…' }), ...BANKS.map(([c, n]) => el('option', { value: n, text: n + ' (' + c + ')' }))]) });
    const acct = f('k-acct', 'Número de cuenta', { inputmode: 'numeric', placeholder: '20 dígitos…', translate: 'no' }, 'A nombre de la empresa.');
    const err = el('div', { class: 'full' });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Enviar para revisión' });
    const form = el('form', { class: 'form-grid', novalidate: true }, [legal, rep, repId, phone, addr, bank, acct, err, el('div', { class: 'full' }, [btn])]);
    const g = (x) => x.querySelector('input, select, textarea');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.replaceChildren();
      const ok = validate([
        [g(legal), (v) => (v.trim().length >= 3 ? null : 'Escribe la razón social.')],
        [g(rep), (v) => (v.trim().length >= 3 ? null : 'Escribe el nombre del representante.')],
        [g(repId), (v) => (/^[VE]-?\d{6,9}$/i.test(v.trim()) ? null : 'La cédula debe tener la forma V-12345678.')],
        [g(phone), (v) => (/^0\d{3}-?\d{7}$/.test(v.trim().replace(/\s/g, '')) ? null : 'Escribe el teléfono con su código, como 0414-1234567.')],
        [g(addr), (v) => (v.trim().length >= 10 ? null : 'Escribe la dirección fiscal completa.')],
        [g(bank), (v) => (v ? null : 'Elige el banco.')],
        [g(acct), (v) => (/^\d{20}$/.test(v.replace(/[\s-]/g, '')) ? null : 'La cuenta debe tener 20 dígitos.')],
      ]);
      if (!ok) return;
      setBusy(btn, true, 'Enviando…');
      try {
        const nm = await api.post('/account/kyc', {
          legal_name: g(legal).value.trim(), representative_name: g(rep).value.trim(), representative_id: g(repId).value.trim().toUpperCase(),
          address: g(addr).value.trim(), phone: g(phone).value.trim(), bank_name: g(bank).value, bank_account: g(acct).value.replace(/[\s-]/g, ''),
        });
        state.session.merchant = nm;
        if (!alive(tok)) return;
        // Actualiza el estado del menú lateral sin perder la página
        const acctBox = document.querySelector('.acct');
        if (acctBox) { const ki = kycInfo(nm); acctBox.replaceChildren(el('b', { text: nm.business_name }), el('div', {}, [pill(ki.text, ki.tone)])); }
        drawKyc(card, tok);
        card.querySelector('h2').setAttribute('tabindex', '-1');
        card.querySelector('h2').focus();
        toast('Datos enviados para revisión');
      } catch (ex) { setBusy(btn, false); err.replaceChildren(errorBanner(ex, 'No pudimos enviar los datos')); }
    });
    card.replaceChildren(head, el('p', { class: 'muted', text: 'Para cobrar con dinero real necesitamos los datos de tu empresa. Mientras los revisamos puedes seguir usando el modo de prueba.' }), form);
  }

  // ---------------------------------------------------------------------------
  // 404
  // ---------------------------------------------------------------------------
  function notFound(main) {
    setTitle('Página no encontrada');
    const inDash = main.classList.contains('dash-main');
    main.replaceChildren(el('div', { class: inDash ? 'notfound' : 'wrap notfound' }, [
      el('h1', { tabindex: '-1', text: 'No encontramos esta página' }),
      el('p', { class: 'muted', text: 'Puede que el enlace esté incompleto o que la página ya no exista.' }),
      el('a', { class: 'btn', href: inDash ? '#/dashboard' : '#/', text: inDash ? 'Volver al inicio del panel' : 'Volver al inicio' }),
    ]));
  }

  // ---------------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------------
  window.addEventListener('hashchange', render);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const side = $('side');
    if (side && side.classList.contains('open') && !document.querySelector('dialog[open]')) {
      side.classList.remove('open');
      const b = document.querySelector('[aria-controls=side]');
      if (b) { b.setAttribute('aria-expanded', 'false'); b.focus(); }
    }
  });
  render();
})();
