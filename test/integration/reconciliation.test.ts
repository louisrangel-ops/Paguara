import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertsService } from '../../src/alerts/alerts.service';
import { ReconciliationService, reconcilablePairs } from '../../src/reconciliation/reconciliation.service';
import { SandboxStatementSource } from '../../src/reconciliation/sandbox-statement.source';
import { parseStatementCsv } from '../../src/reconciliation/statement-parser';
import { RailCredentialsService } from '../../src/secrets/rail-credentials.service';
import { Ctx, seedRates, setup } from './helpers';

let ctx: Ctx;
let alerts: AlertsService;
let recon: ReconciliationService;
const sent: string[] = [];

before(async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://alertas.example/hook';
  ctx = await setup();
  await seedRates(ctx.fx);
  alerts = new AlertsService(ctx.pool);
  alerts.send = async (_url, body) => { sent.push(body); };
  const sources = [...new Set(reconcilablePairs().map((p) => p.rail))].map((r) => new SandboxStatementSource(r, ctx.pool));
  recon = new ReconciliationService(ctx.pool, ctx.settlements, alerts, new RailCredentialsService(ctx.pool), sources);
});
after(async () => {
  delete process.env.ALERT_WEBHOOK_URL;
  await ctx.teardown();
});

/** Como lo escribe el banco: 1.234,56 */
const bs = (minor: bigint) => `${(minor / 100n).toLocaleString('es-VE')},${String(minor % 100n).padStart(2, '0')}`;
const code = (c: string) => (e: { code: string }) => e.code === c;

/** Un cobro C2P aprobado por el riel de prueba: referencia, monto en Bs y día en Caracas. */
async function charge(m: string, usdCents: bigint) {
  let pi = await ctx.payments.create(m, { amount: usdCents, currency: 'USD' });
  pi = await ctx.payments.attachPaymentMethod(m, pi.id, 'pago_movil_c2p');
  pi = await ctx.payments.confirm(m, pi.id, { phone: '04141234567', bank: '0102', otp: '123456' });
  const { rows: [r] } = await ctx.pool.query<{ rail_reference: string; charge_amount: bigint; day: string }>(
    `SELECT rail_reference, charge_amount, to_char((succeeded_at AT TIME ZONE 'America/Caracas')::date, 'YYYY-MM-DD') AS day
       FROM payments.payment_intents WHERE id = $1`, [pi.id]);
  return { id: pi.id, ref: r.rail_reference, amount: r.charge_amount, day: r.day };
}
const fundsReceived = async (id: string) =>
  (await ctx.pool.query('SELECT funds_received_entry_id FROM payments.payment_intents WHERE id = $1', [id])).rows[0].funds_received_entry_id !== null;
const openKinds = async () => (await recon.openDiscrepancies()).filter((d) => d.rail === 'ves_c2p').map((d) => `${d.kind}:${d.payment_intent_id ?? d.movement_id}`).sort();

test('conciliación: cruza por referencia y monto, libera solo lo que llegó y alerta las diferencias', async () => {
  const m = await ctx.merchant('acct_recon');
  const ok = await charge(m, 2000n);
  const short = await charge(m, 3000n);
  const lost = await charge(m, 4000n);
  const day = ok.day;
  assert.equal(await fundsReceived(ok.id), false);

  // Extracto del banco: uno exacto, uno con 1 Bs menos, un crédito que no es de ningún cobro y el tercero no está
  const csv = ['fecha;referencia;monto;descripcion',
    `${day};${ok.ref};${bs(ok.amount)};Pago Móvil`,
    `${day};${short.ref};${bs(short.amount - 100n)};Pago Móvil`,
    `${day};X999;150,00;Transferencia sin identificar`,
    `${day};COM1;-5,00;Comisión del banco`].join('\n');
  const imported = await recon.importStatement({ rail: 'ves_c2p', currency: 'VES', statementDate: day, source: 'file', movements: parseStatementCsv(csv, 'VES') }, 'platform:Ana');
  assert.equal(imported.new_movements, 4);
  const again = await recon.importStatement({ rail: 'ves_c2p', currency: 'VES', statementDate: day, source: 'file', movements: parseStatementCsv(csv, 'VES') }, 'platform:Ana');
  assert.equal(again.duplicate, true, 'el mismo archivo dos veces no duplica movimientos');

  const run = await recon.run({ rail: 'ves_c2p', currency: 'VES', date: day }, 'platform:system');
  assert.equal(run.status, 'discrepancies');
  assert.equal(run.matched_count, 1);
  assert.deepEqual(run.discrepancies.map((d: { kind: string }) => d.kind).sort(), ['amount_mismatch', 'missing_in_bank', 'missing_in_ledger']);
  assert.ok(run.released_entry_id, 'los fondos del cobro cruzado se liberaron');
  assert.equal(await fundsReceived(ok.id), true);
  assert.equal(await fundsReceived(short.id), false, 'el monto distinto no se libera');
  assert.equal(await fundsReceived(lost.id), false, 'el que no llegó al banco no se libera');
  assert.equal(await ctx.ledger.balance(`merchant:${m}:available:VES`) > 0n, true);

  // Alerta crítica (falta dinero), enviada una sola vez
  const open = await alerts.open();
  const a = open.find((x) => x.kind === 'reconciliation_discrepancies')!;
  assert.equal(a.severity, 'critical');
  assert.match(a.title, /1 cobro\(s\) sin dinero en el banco, 1 con monto distinto, 1 crédito\(s\) del banco sin cobro/);
  assert.equal(sent.length, 1);
  assert.match(JSON.parse(sent[0]).text, /^🔴 \[Paguara\] Conciliación ves_c2p/);

  // Repetir la corrida no duplica diferencias ni alertas ni vuelve a liberar
  const rerun = await recon.run({ rail: 'ves_c2p', currency: 'VES', date: day }, 'platform:system');
  assert.equal(rerun.matched_count, 0);
  assert.equal(rerun.released_entry_id, null);
  assert.equal((await openKinds()).length, 3);
  assert.equal(sent.length, 1);
  assert.equal((await alerts.open()).find((x) => x.id === a.id)!.occurrences, 2);

  // Llega el extracto corregido (el día completo) con el cobro perdido: cuadra y su diferencia se cierra sola
  const corrected = await recon.importStatement({ rail: 'ves_c2p', currency: 'VES', statementDate: day, source: 'file',
    movements: [...parseStatementCsv(csv, 'VES'), { valueDate: day, amount: lost.amount, reference: lost.ref }] }, 'platform:Ana');
  assert.equal(corrected.new_movements, 1);
  assert.equal(corrected.superseded, 0);
  const third = await recon.run({ rail: 'ves_c2p', currency: 'VES', date: day }, 'platform:system');
  assert.equal(third.matched_count, 1);
  assert.equal(await fundsReceived(lost.id), true);
  assert.deepEqual((await openKinds()).map((k) => k.split(':')[0]), ['amount_mismatch', 'missing_in_ledger']);

  // Las demás las cierra una persona con una nota
  const mismatch = (await recon.openDiscrepancies()).find((d) => d.kind === 'amount_mismatch')!;
  await assert.rejects(recon.resolve(mismatch.id, 'platform:Ana', 'ok'), code('resolution_required'));
  await recon.resolve(mismatch.id, 'platform:Ana', 'El banco cobró 1 Bs de comisión; se reclamó con el ticket 4411');
  await assert.rejects(recon.resolve(mismatch.id, 'platform:Ana', 'otra vez la nota'), code('resource_missing'));
  await alerts.acknowledge(a.id, 'platform:Ana');
  assert.ok(!(await alerts.open()).some((x) => x.id === a.id));
});

test('conciliación: un día sin extracto es una diferencia; un riel desconocido se rechaza', async () => {
  const run = await recon.run({ rail: 'zelle', currency: 'USD', date: '2026-01-05' }, 'platform:system');
  assert.equal(run.status, 'discrepancies');
  assert.deepEqual(run.discrepancies.map((d: { kind: string }) => d.kind), ['statement_missing']);
  await recon.importStatement({ rail: 'zelle', currency: 'USD', statementDate: '2026-01-05', source: 'file', movements: [] }, 'platform:Ana');
  const after = await recon.run({ rail: 'zelle', currency: 'USD', date: '2026-01-05' }, 'platform:system');
  assert.equal(after.status, 'clean');
  assert.ok(!(await recon.openDiscrepancies()).some((d) => d.rail === 'zelle'));
  await assert.rejects(recon.run({ rail: 'zelle', currency: 'VES', date: '2026-01-05' }, 'x'), code('rail_invalid'));
  await assert.rejects(recon.run({ rail: 'zelle', currency: 'USD', date: '05-01-2026' }, 'x'), code('date_invalid'));
});

test('job diario con el banco simulado del sandbox: trae el extracto, concilia todos los rieles y libera los fondos', async () => {
  const m = await ctx.merchant('acct_recon_daily');
  const pi = await charge(m, 1500n);
  const out = await recon.runDaily(pi.day, 'platform:system');
  assert.equal(out.results.length, reconcilablePairs().length);
  assert.ok(out.results.every((r) => r.status !== 'failed'), JSON.stringify(out.results));
  assert.equal(await fundsReceived(pi.id), true);
  assert.equal(out.results.find((r) => r.rail === 'zelle')!.status, 'clean');
  const runs = await recon.listRuns(100);
  assert.ok(runs.some((r) => r.rail === 'ves_c2p' && r.run_date === pi.day));
});

test('extracto corregido: reemplaza al anterior del mismo día y avisa si quita algo ya conciliado', async () => {
  const m = await ctx.merchant('acct_recon_fix');
  const pi = await charge(m, 2500n);
  const other = await charge(m, 1000n);
  const day = '2026-02-10';
  await ctx.pool.query(`UPDATE payments.payment_intents SET succeeded_at = $2::date + interval '15 hours' WHERE id = ANY($1)`, [[pi.id, other.id], day]);
  const imp = (movements: Array<{ valueDate: string; amount: bigint; reference: string }>) =>
    recon.importStatement({ rail: 'ves_c2p', currency: 'VES', statementDate: day, source: 'file', movements }, 'platform:Ana');

  // Primero el banco reporta 1 Bs menos y el otro cobro exacto
  await imp([{ valueDate: day, amount: pi.amount - 100n, reference: pi.ref }, { valueDate: day, amount: other.amount, reference: other.ref }]);
  const first = await recon.run({ rail: 'ves_c2p', currency: 'VES', date: day }, 'platform:system');
  assert.deepEqual(first.discrepancies.map((d: { kind: string }) => d.kind), ['amount_mismatch']);
  assert.equal(await fundsReceived(other.id), true);

  // El extracto corregido trae el monto bueno y ya no trae el otro (que ya se cruzó y liberó)
  sent.length = 0;
  const fixed = await imp([{ valueDate: day, amount: pi.amount, reference: pi.ref }]);
  assert.equal(fixed.superseded, 1, 'el movimiento de 1 Bs menos queda reemplazado');
  assert.equal(fixed.matched_but_removed, 1);
  const conflict = (await alerts.open()).find((a) => a.kind === 'statement_correction_conflict')!;
  assert.equal(conflict.severity, 'critical');
  assert.match(conflict.detail.movements[0], new RegExp(other.id));
  assert.equal(sent.length, 1);

  const second = await recon.run({ rail: 'ves_c2p', currency: 'VES', date: day }, 'platform:system');
  assert.equal(second.matched_count, 1);
  assert.equal(second.status, 'clean', 'el movimiento reemplazado no queda como crédito sin cobro');
  assert.equal(await fundsReceived(pi.id), true);
  assert.ok(!(await recon.openDiscrepancies()).some((d) => d.payment_intent_id === pi.id || d.payment_intent_id === other.id));
});

test('alertas: una que sube de atención a crítica cambia de gravedad y se vuelve a enviar', async () => {
  sent.length = 0;
  const key = 'recon:prueba:VES:2026-03-01';
  await alerts.raise({ severity: 'warning', kind: 'reconciliation_discrepancies', dedupeKey: key, title: 'falta el extracto' });
  await alerts.raise({ severity: 'warning', kind: 'reconciliation_discrepancies', dedupeKey: key, title: 'falta el extracto' });
  assert.equal(sent.length, 1);
  await alerts.raise({ severity: 'critical', kind: 'reconciliation_discrepancies', dedupeKey: key, title: '1 cobro sin dinero en el banco' });
  assert.equal(sent.length, 2, 'la escalada se avisa');
  await alerts.raise({ severity: 'warning', kind: 'reconciliation_discrepancies', dedupeKey: key, title: 'falta el extracto' });
  assert.equal(sent.length, 2, 'bajar de gravedad no reenvía');
  const a = (await alerts.open()).find((x) => x.title === 'falta el extracto' || x.title === '1 cobro sin dinero en el banco')!;
  assert.equal(a.severity, 'critical', 'una alerta abierta nunca baja de gravedad');
  assert.equal(a.occurrences, 4);
});

test('dos corridas a la vez del mismo riel no fallan ni liberan dos veces', async () => {
  const m = await ctx.merchant('acct_recon_race');
  const pis = [await charge(m, 1100n), await charge(m, 1200n), await charge(m, 1300n)];
  const day = '2026-04-07';
  await ctx.pool.query(`UPDATE payments.payment_intents SET succeeded_at = $2::date + interval '15 hours' WHERE id = ANY($1)`, [pis.map((p) => p.id), day]);
  await recon.importStatement({ rail: 'ves_c2p', currency: 'VES', statementDate: day, source: 'file',
    movements: pis.map((p) => ({ valueDate: day, amount: p.amount, reference: p.ref })) }, 'platform:Ana');
  const runs = await Promise.all([1, 2, 3].map(() => recon.run({ rail: 'ves_c2p', currency: 'VES', date: day }, 'platform:system')));
  assert.ok(runs.every((r) => r.status !== 'failed'), JSON.stringify(runs.map((r) => r.error)));
  assert.equal(runs.reduce((n, r) => n + r.matched_count, 0), 3);
  assert.equal(runs.filter((r) => r.released_entry_id).length >= 1, true);
  for (const p of pis) assert.equal(await fundsReceived(p.id), true);
  // Lo que ve la corrida que esperó el lock: los cobros ya liberados se saltan en vez de fallar
  assert.equal(await ctx.settlements.recordRailFunds('rec_tarde', 'ves_c2p', 'VES', pis.map((p) => p.id), { skipAlreadyReceived: true }), null);
  await assert.rejects(ctx.settlements.recordRailFunds('lote_manual', 'ves_c2p', 'VES', [pis[0].id]), code('funds_already_received'));
});
