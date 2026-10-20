/**
 * Tareas periódicas del entorno de desarrollo, mientras no exista el job real
 * de tasas (BCV, Binance P2P, exchange). Habla con la API interna como lo haría
 * cualquier cron:
 *   - cada FX_REFRESH_SECONDS carga tasas FIJAS (DEV_FX_RATES), para que los cobros no fallen con fx_rate_unavailable
 *   - cada EXPIRE_EVERY_SECONDS vence los PaymentIntents abandonados
 *   - cada RECON_EVERY_SECONDS concilia ayer y hoy contra el banco simulado del
 *     sandbox, que libera los fondos de los cobros para el corte
 * Nunca usar en producción: las tasas no son reales.
 */
const APP_URL = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.INTERNAL_API_TOKEN;
// par:fuente:tasa, separados por coma. La tasa es "unidades de quote por 1 de base".
const RATES = process.env.DEV_FX_RATES ?? 'USD/VES:BCV:36.5,USDT/VES:BINANCE_P2P:37.2,USD/USDT:EXCHANGE:1.0005';
const FX_EVERY = Number(process.env.FX_REFRESH_SECONDS ?? 3600) * 1000;
const EXPIRE_EVERY = Number(process.env.EXPIRE_EVERY_SECONDS ?? 60) * 1000;
const RECON_EVERY = Number(process.env.RECON_EVERY_SECONDS ?? 3600) * 1000;

if (process.env.LIVEMODE === 'true') {
  console.error('[dev-jobs] LIVEMODE=true: este proceso carga tasas ficticias y no corre en producción');
  process.exit(1);
}
if (!TOKEN) {
  console.error('[dev-jobs] INTERNAL_API_TOKEN no está definido');
  process.exit(1);
}

async function internal(path: string, body: unknown) {
  const res = await fetch(`${APP_URL}/internal/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN! },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function loadRates() {
  for (const spec of RATES.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [pair, source, rate] = spec.split(':');
    const [base, quote] = (pair ?? '').split('/');
    if (!base || !quote || !source || !rate) throw new Error(`DEV_FX_RATES mal formado: "${spec}"`);
    await internal('fx/rates', { base, quote, rate, source });
  }
  console.log(`[dev-jobs] tasas cargadas: ${RATES}`);
}

async function expire() {
  const { canceled } = await internal('payment_intents/expire', {}) as { canceled: number };
  if (canceled) console.log(`[dev-jobs] vencidos: ${canceled}`);
}

async function reconcile() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date());
  for (const date of [undefined, today]) {
    const { results } = await internal('reconciliation/daily', date ? { date } : {}) as { results: Array<{ status: string }> };
    const bad = results.filter((r) => r.status !== 'clean').length;
    if (bad) console.log(`[dev-jobs] conciliación ${date ?? 'de ayer'}: ${bad} riel(es) con diferencias (ver /admin)`);
  }
}

/** Corre `fn` ya y luego cada `ms`; un fallo (la API aún arrancando) se registra y se reintenta en la siguiente vuelta. */
function every(ms: number, fn: () => Promise<void>) {
  const run = () => fn().catch((e) => console.error(`[dev-jobs] ${(e as Error).message}`));
  void run();
  setInterval(run, ms);
}

every(FX_EVERY, loadRates);
every(EXPIRE_EVERY, expire);
every(RECON_EVERY, reconcile);

export {};
