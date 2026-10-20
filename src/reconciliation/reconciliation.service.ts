import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { AlertsService } from '../alerts/alerts.service';
import { ApiError } from '../common/errors';
import { Currency, formatMinor } from '../common/money';
import { PG_POOL, withTransaction } from '../database/database';
import { PAYMENT_METHODS } from '../payment-intents/payment-methods';
import { RailCredentialsService } from '../secrets/rail-credentials.service';
import { SettlementsService } from '../settlements/settlements.service';
import { BankMovement, contentHash, parseDate } from './statement-parser';

/** Días hacia atrás en que un cobro o un movimiento todavía puede cruzarse. */
const lookbackDays = () => Number(process.env.RECON_LOOKBACK_DAYS ?? 7);
/** Días de gracia antes de reportar un cobro sin dinero en el banco (0: ya en la corrida de su día). */
const graceDays = () => Number(process.env.RECON_GRACE_DAYS ?? 0);
const TZ = 'America/Caracas';

/**
 * Fuente automática de extractos de un riel (API de movimientos del banco). Los
 * rieles sin fuente se concilian con el extracto que se importa a mano o por
 * SFTP (POST /internal/reconciliation/statements).
 */
export interface StatementSource {
  readonly rail: string;
  readonly kind: 'api' | 'sandbox';
  fetch(currency: Currency, date: string): Promise<BankMovement[]>;
}
export const STATEMENT_SOURCES = Symbol('STATEMENT_SOURCES');

export type DiscrepancyKind = 'missing_in_bank' | 'missing_in_ledger' | 'amount_mismatch' | 'statement_missing';

/** Pares riel/moneda que se concilian: los de los métodos de pago. */
export function reconcilablePairs(): Array<{ rail: string; currency: Currency }> {
  const seen = new Map<string, { rail: string; currency: Currency }>();
  for (const m of Object.values(PAYMENT_METHODS)) seen.set(`${m.rail}:${m.chargeCurrency}`, { rail: m.rail, currency: m.chargeCurrency });
  return [...seen.values()];
}

/** Ayer en Caracas: el día que concilia el job de la mañana. */
export function yesterdayInCaracas(now = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function railAndCurrency(rail: unknown, currency: unknown): { rail: string; currency: Currency } {
  const pair = reconcilablePairs().find((p) => p.rail === rail && p.currency === currency);
  if (!pair) throw new ApiError(400, 'rail_invalid', `No se concilia el riel ${String(rail)} en ${String(currency)}`);
  return pair;
}

/**
 * Conciliación diaria: cruza lo que dice el banco (extracto) con lo que dice el
 * ledger (cobros capturados), por referencia del banco y monto.
 *
 *  - cuadra (misma referencia y monto) → queda en `matches` y libera el neto al comercio
 *    (pending → available), que recién entonces entra en un corte de liquidación;
 *  - cobro sin dinero en el banco (`missing_in_bank`) → alerta crítica: es lo que
 *    detecta un pago marcado como recibido que nunca llegó;
 *  - crédito del banco sin cobro (`missing_in_ledger`), monto distinto
 *    (`amount_mismatch`) o día sin extracto (`statement_missing`) → diferencia y alerta.
 *
 * Las diferencias abiertas se actualizan en cada corrida y se cierran solas si
 * luego cuadran; las demás las cierra una persona con una nota.
 */
@Injectable()
export class ReconciliationService {
  private readonly log = new Logger(ReconciliationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly settlements: SettlementsService,
    private readonly alerts: AlertsService,
    private readonly credentials: RailCredentialsService,
    @Inject(STATEMENT_SOURCES) private readonly sources: StatementSource[],
  ) {}

  async importStatement(input: { rail: unknown; currency: unknown; statementDate: unknown; source: 'file' | 'api' | 'sandbox'; movements: BankMovement[] }, actor: string) {
    const { rail, currency } = railAndCurrency(input.rail, input.currency);
    let date: string;
    try { date = parseDate(String(input.statementDate ?? '')); } catch (e) { throw new ApiError(400, 'statement_date_invalid', (e as Error).message); }
    if (input.movements.length > 50_000) throw new ApiError(400, 'statement_too_large', 'Máximo 50.000 movimientos por extracto');
    return withTransaction(this.pool, async (c) => {
      const hash = contentHash(input.movements);
      const { rows: [existing] } = await c.query<{ id: string }>(
        'SELECT id FROM reconciliation.statements WHERE rail = $1 AND currency = $2 AND statement_date = $3 AND content_sha256 = $4',
        [rail, currency, date, hash]);
      if (existing) return { id: existing.id, movements: input.movements.length, new_movements: 0, duplicate: true };
      const id = `bst_${randomBytes(10).toString('hex')}`;
      await c.query(
        `INSERT INTO reconciliation.statements (id, rail, currency, statement_date, source, content_sha256, movement_count, imported_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, rail, currency, date, input.source, hash, input.movements.length, actor]);
      let fresh = 0;
      for (const m of input.movements) {
        const res = await c.query(
          `INSERT INTO reconciliation.movements (statement_id, rail, currency, value_date, amount, reference, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (rail, currency, value_date, reference, amount) DO NOTHING`,
          [id, rail, currency, m.valueDate, m.amount.toString(), m.reference, m.description ?? null]);
        fresh += res.rowCount ?? 0;
      }
      return { id, movements: input.movements.length, new_movements: fresh, duplicate: false };
    });
  }

  /** Concilia un riel y moneda en un día. Repetirla es seguro: lo ya cruzado no se vuelve a cruzar ni a liberar. */
  async run(input: { rail: unknown; currency: unknown; date: unknown }, actor: string) {
    const { rail, currency } = railAndCurrency(input.rail, input.currency);
    let date: string;
    try { date = parseDate(String(input.date ?? '')); } catch (e) { throw new ApiError(400, 'date_invalid', (e as Error).message); }
    const runId = `rec_${randomBytes(10).toString('hex')}`;
    await this.pool.query('INSERT INTO reconciliation.runs (id, rail, currency, run_date, triggered_by) VALUES ($1, $2, $3, $4, $5)',
      [runId, rail, currency, date, actor]);
    try {
      const summary = await this.match(runId, rail, currency, date);
      const released = await this.releaseMatched(runId, rail, currency);
      await this.pool.query(
        `UPDATE reconciliation.runs SET status = $2, ledger_count = $3, bank_count = $4, matched_count = $5, ledger_total = $6,
                bank_total = $7, matched_total = $8, released_entry_id = $9, finished_at = now() WHERE id = $1`,
        [runId, summary.found.length ? 'discrepancies' : 'clean', summary.ledgerCount, summary.bankCount, summary.matchedCount,
         summary.ledgerTotal.toString(), summary.bankTotal.toString(), summary.matchedTotal.toString(), released]);
      if (summary.found.length) await this.alertDiscrepancies(runId, rail, currency, date, summary.found);
      return this.getRun(runId);
    } catch (e) {
      const msg = (e as Error).message;
      this.log.error(`Conciliación ${rail}/${currency} ${date} falló: ${msg}`);
      await this.pool.query(`UPDATE reconciliation.runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [runId, msg.slice(0, 500)]);
      await this.alerts.raise({ severity: 'critical', kind: 'reconciliation_failed', dedupeKey: `recon_failed:${rail}:${currency}:${date}`,
        title: `La conciliación de ${rail} (${currency}) del ${date} falló: ${msg}`, detail: { run_id: runId, rail, currency, date } });
      throw e;
    }
  }

  private match(runId: string, rail: string, currency: Currency, date: string) {
    return withTransaction(this.pool, async (c) => {
      // Una sola conciliación a la vez por riel y moneda
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recon:${rail}:${currency}`]);
      const params = [rail, currency, date, lookbackDays()];
      const { rows: charges } = await c.query<{ id: string; rail_reference: string | null; charge_amount: bigint; day: string }>(
        `SELECT pi.id, pi.rail_reference, pi.charge_amount, to_char((pi.succeeded_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day
           FROM payments.payment_intents pi
          WHERE pi.rail = $1 AND pi.charge_currency = $2 AND pi.capture_entry_id IS NOT NULL
            AND (pi.succeeded_at AT TIME ZONE '${TZ}')::date BETWEEN $3::date - $4::int AND $3::date
            AND NOT EXISTS (SELECT 1 FROM reconciliation.matches m WHERE m.payment_intent_id = pi.id)
          ORDER BY pi.succeeded_at, pi.id`, params);
      const { rows: movements } = await c.query<{ id: string; reference: string; amount: bigint; day: string }>(
        `SELECT mv.id::text, mv.reference, mv.amount, to_char(mv.value_date, 'YYYY-MM-DD') AS day
           FROM reconciliation.movements mv
          WHERE mv.rail = $1 AND mv.currency = $2 AND mv.amount > 0
            AND mv.value_date BETWEEN $3::date - $4::int AND $3::date
            AND NOT EXISTS (SELECT 1 FROM reconciliation.matches m WHERE m.movement_id = mv.id)
          ORDER BY mv.value_date, mv.id`, params);

      const byRef = new Map<string, typeof movements>();
      for (const m of movements) byRef.set(m.reference, [...(byRef.get(m.reference) ?? []), m]);
      const used = new Set<string>();
      const found: Array<{ kind: DiscrepancyKind; itemKey: string; piId?: string; movementId?: string; expected?: bigint; bank?: bigint; detail: string }> = [];
      const cutoff = new Date(`${date}T00:00:00Z`);
      cutoff.setUTCDate(cutoff.getUTCDate() - graceDays());
      const due = (day: string) => new Date(`${day}T00:00:00Z`) <= cutoff;
      let matchedCount = 0, matchedTotal = 0n;

      for (const pi of charges) {
        const candidates = (pi.rail_reference ? byRef.get(pi.rail_reference) ?? [] : []).filter((m) => !used.has(m.id));
        const exact = candidates.find((m) => m.amount === pi.charge_amount);
        if (exact) {
          used.add(exact.id);
          await c.query('INSERT INTO reconciliation.matches (payment_intent_id, movement_id, run_id) VALUES ($1, $2, $3)', [pi.id, exact.id, runId]);
          matchedCount++; matchedTotal += pi.charge_amount;
        } else if (candidates.length) {
          const mv = candidates[0];
          used.add(mv.id);
          found.push({ kind: 'amount_mismatch', itemKey: pi.id, piId: pi.id, movementId: mv.id, expected: pi.charge_amount, bank: mv.amount,
            detail: `El cobro ${pi.id} es de ${formatMinor(pi.charge_amount, currency)} ${currency} y el banco acreditó ${formatMinor(mv.amount, currency)} con la referencia ${mv.reference}` });
        } else if (due(pi.day)) {
          found.push({ kind: 'missing_in_bank', itemKey: pi.id, piId: pi.id, expected: pi.charge_amount,
            detail: `El cobro ${pi.id} (${formatMinor(pi.charge_amount, currency)} ${currency}, referencia ${pi.rail_reference ?? 'sin referencia'}, del ${pi.day}) no aparece en el banco` });
        }
      }
      for (const mv of movements) {
        if (used.has(mv.id) || !due(mv.day)) continue;
        found.push({ kind: 'missing_in_ledger', itemKey: `mv:${mv.id}`, movementId: mv.id, bank: mv.amount,
          detail: `El banco acreditó ${formatMinor(mv.amount, currency)} ${currency} con la referencia ${mv.reference} el ${mv.day} y no hay un cobro con esa referencia` });
      }
      const { rowCount: statements } = await c.query(
        'SELECT 1 FROM reconciliation.statements WHERE rail = $1 AND currency = $2 AND statement_date = $3', [rail, currency, date]);
      if (!statements) found.push({ kind: 'statement_missing', itemKey: date, detail: `No se importó el extracto de ${rail} (${currency}) del ${date}` });

      for (const f of found) {
        await c.query(
          `INSERT INTO reconciliation.discrepancies (id, rail, currency, kind, item_key, payment_intent_id, movement_id, expected_amount, bank_amount, detail, first_run_id, last_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
           ON CONFLICT (rail, currency, kind, item_key) WHERE resolved_at IS NULL
           DO UPDATE SET last_run_id = EXCLUDED.last_run_id, detail = EXCLUDED.detail, bank_amount = EXCLUDED.bank_amount, movement_id = EXCLUDED.movement_id`,
          [`dsc_${randomBytes(10).toString('hex')}`, rail, currency, f.kind, f.itemKey, f.piId ?? null, f.movementId ?? null,
           f.expected?.toString() ?? null, f.bank?.toString() ?? null, f.detail, runId]);
      }
      // Lo que ya cuadró (o el extracto que llegó) cierra sus diferencias abiertas
      await c.query(
        `UPDATE reconciliation.discrepancies d SET resolved_at = now(), resolved_by = 'system:reconciliation', resolution = $3
          WHERE d.rail = $1 AND d.currency = $2 AND d.resolved_at IS NULL AND (
                (d.kind IN ('missing_in_bank', 'amount_mismatch') AND EXISTS (SELECT 1 FROM reconciliation.matches m WHERE m.payment_intent_id = d.payment_intent_id))
             OR (d.kind = 'missing_in_ledger' AND EXISTS (SELECT 1 FROM reconciliation.matches m WHERE m.movement_id = d.movement_id))
             OR (d.kind = 'statement_missing' AND EXISTS (SELECT 1 FROM reconciliation.statements s
                   WHERE s.rail = d.rail AND s.currency = d.currency AND s.statement_date = d.item_key::date)))`,
        [rail, currency, `Cuadró en la conciliación ${runId}`]);

      return {
        found, matchedCount, matchedTotal,
        ledgerCount: charges.length, ledgerTotal: charges.reduce((s, p) => s + p.charge_amount, 0n),
        bankCount: movements.length, bankTotal: movements.reduce((s, m) => s + m.amount, 0n),
      };
    });
  }

  /**
   * Libera a los comercios lo que el banco confirmó: los cobros cruzados que
   * todavía no tienen fondos recibidos (también los de corridas anteriores, si
   * una falló a mitad) pasan de "por recibir" a "disponible".
   */
  private async releaseMatched(runId: string, rail: string, currency: Currency): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT pi.id FROM reconciliation.matches m JOIN payments.payment_intents pi ON pi.id = m.payment_intent_id
        WHERE pi.rail = $1 AND pi.charge_currency = $2 AND pi.funds_received_entry_id IS NULL ORDER BY pi.id`, [rail, currency]);
    if (!rows.length) return null;
    const entry = await this.settlements.recordRailFunds(runId, rail, currency, rows.map((r) => r.id));
    return entry.entryId;
  }

  private async alertDiscrepancies(runId: string, rail: string, currency: Currency, date: string, found: Array<{ kind: DiscrepancyKind; detail: string }>) {
    const count = (k: DiscrepancyKind) => found.filter((f) => f.kind === k).length;
    const critical = count('missing_in_bank') + count('amount_mismatch') > 0;
    const parts = [
      count('missing_in_bank') && `${count('missing_in_bank')} cobro(s) sin dinero en el banco`,
      count('amount_mismatch') && `${count('amount_mismatch')} con monto distinto`,
      count('missing_in_ledger') && `${count('missing_in_ledger')} crédito(s) del banco sin cobro`,
      count('statement_missing') && 'falta el extracto',
    ].filter(Boolean);
    await this.alerts.raise({
      severity: critical ? 'critical' : 'warning', kind: 'reconciliation_discrepancies', dedupeKey: `recon:${rail}:${currency}:${date}`,
      title: `Conciliación ${rail} (${currency}) del ${date}: ${parts.join(', ')}`,
      detail: { run_id: runId, rail, currency, date, discrepancies: found.slice(0, 20).map((f) => f.detail) },
    });
  }

  /**
   * El job de cada mañana: trae los extractos de los rieles con fuente
   * automática, concilia todos los rieles del día y avisa de certificados por vencer.
   */
  async runDaily(date: string, actor: string) {
    const results: Array<{ rail: string; currency: string; status: string; run_id?: string; error?: string }> = [];
    for (const { rail, currency } of reconcilablePairs()) {
      try {
        const source = this.sources.find((s) => s.rail === rail);
        if (source) {
          await this.importStatement({ rail, currency, statementDate: date, source: source.kind,
            movements: await source.fetch(currency, date) }, actor);
        }
        const run = await this.run({ rail, currency, date }, actor);
        results.push({ rail, currency, status: run.status, run_id: run.id });
      } catch (e) {
        results.push({ rail, currency, status: 'failed', error: (e as Error).message });
      }
    }
    for (const cert of await this.credentials.expiringCertificates(30)) {
      await this.alerts.raise({ severity: 'warning', kind: 'certificate_expiring', dedupeKey: `cert:${cert.rail}:${cert.name}`,
        title: `El certificado ${cert.rail}/${cert.name} vence el ${cert.expires_at.toISOString().slice(0, 10)}: pide uno nuevo al banco`,
        detail: { rail: cert.rail, name: cert.name, expires_at: cert.expires_at } });
    }
    return { date, results };
  }

  async listRuns(limit = 50) {
    const { rows } = await this.pool.query(
      `SELECT id, rail, currency, to_char(run_date, 'YYYY-MM-DD') AS run_date, status, ledger_count, bank_count, matched_count,
              ledger_total::text, bank_total::text, matched_total::text, error, triggered_by, started_at, finished_at
         FROM reconciliation.runs ORDER BY started_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 200)]);
    return rows;
  }

  async getRun(id: string) {
    const { rows: [run] } = await this.pool.query(
      `SELECT id, rail, currency, to_char(run_date, 'YYYY-MM-DD') AS run_date, status, ledger_count, bank_count, matched_count,
              ledger_total::text, bank_total::text, matched_total::text, released_entry_id, error, triggered_by, started_at, finished_at
         FROM reconciliation.runs WHERE id = $1`, [id]);
    if (!run) throw new ApiError(404, 'resource_missing', `No existe la conciliación ${id}`);
    const { rows: discrepancies } = await this.pool.query(
      `SELECT id, kind, payment_intent_id, movement_id::text, expected_amount::text, bank_amount::text, detail, created_at, resolved_at, resolved_by, resolution
         FROM reconciliation.discrepancies WHERE last_run_id = $1 ORDER BY kind, id`, [id]);
    return { ...run, discrepancies };
  }

  async openDiscrepancies() {
    const { rows } = await this.pool.query(
      `SELECT id, rail, currency, kind, payment_intent_id, movement_id::text, expected_amount::text, bank_amount::text, detail, created_at, last_run_id
         FROM reconciliation.discrepancies WHERE resolved_at IS NULL ORDER BY created_at, id`);
    return rows;
  }

  /** Una persona cierra una diferencia explicando qué pasó (reverso del banco, cobro duplicado, error de tipeo del extracto…). */
  async resolve(id: string, actor: string, resolution: unknown) {
    const note = typeof resolution === 'string' ? resolution.trim() : '';
    if (note.length < 5 || note.length > 500) throw new ApiError(400, 'resolution_required', 'Explica en la nota (5 a 500 caracteres) qué pasó y qué se hizo');
    const res = await this.pool.query(
      `UPDATE reconciliation.discrepancies SET resolved_at = now(), resolved_by = $2, resolution = $3 WHERE id = $1 AND resolved_at IS NULL`, [id, actor, note]);
    if (res.rowCount === 0) throw new ApiError(404, 'resource_missing', `No hay una diferencia abierta ${id}`);
    return { id, resolved: true };
  }
}

