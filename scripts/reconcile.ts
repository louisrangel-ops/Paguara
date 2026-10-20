/**
 * Conciliación diaria (cron de cada mañana, p. ej. 06:00 hora de Caracas):
 * pide a la API que traiga los extractos con fuente automática, concilie todos
 * los rieles del día anterior y dispare las alertas.
 *
 *   APP_URL=http://api.interna:3001 INTERNAL_API_TOKEN=... node dist/scripts/reconcile.js [AAAA-MM-DD]
 *
 * Sale con código 1 si alguna conciliación falló o encontró diferencias, para que
 * el programador de tareas del hosting también lo marque en rojo.
 */
const APP_URL = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.INTERNAL_API_TOKEN;

async function main() {
  if (!TOKEN) throw new Error('INTERNAL_API_TOKEN no está definido');
  const date = process.argv[2];
  const res = await fetch(`${APP_URL}/internal/reconciliation/daily`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': TOKEN },
    body: JSON.stringify(date ? { date } : {}),
  });
  if (!res.ok) throw new Error(`reconciliation/daily → ${res.status} ${await res.text()}`);
  const out = await res.json() as { date: string; results: Array<{ rail: string; currency: string; status: string; error?: string }> };
  for (const r of out.results) console.log(`[reconcile] ${out.date} ${r.rail}/${r.currency}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
  if (out.results.some((r) => r.status !== 'clean')) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[reconcile] ${(e as Error).message}`);
  process.exit(1);
});
