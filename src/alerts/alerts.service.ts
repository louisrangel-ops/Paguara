import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { ApiError } from '../common/errors';
import { PG_POOL } from '../database/database';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertInput {
  severity: AlertSeverity;
  kind: string;
  title: string;
  detail?: Record<string, unknown>;
  /** Alertas con la misma llave abiertas se agrupan (sube `occurrences`) en vez de repetirse. */
  dedupeKey: string;
}

/** Mensaje de texto para Slack, Teams, Discord o Google Chat (todos aceptan {"text": ...}). */
export function alertText(a: AlertInput): string {
  const icon = a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟠' : 'ℹ️';
  return `${icon} [Paguara] ${a.title}`;
}

/**
 * Alertas de operación: quedan en `platform.alerts` (las ve el panel interno) y
 * se envían a ALERT_WEBHOOK_URL si está definida. Una alerta abierta con la
 * misma `dedupeKey` no se repite: suma una ocurrencia y no se vuelve a enviar
 * hasta que alguien la marque como vista.
 */
const RANK = (col: string) => `(CASE ${col} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END)`;

@Injectable()
export class AlertsService {
  private readonly log = new Logger(AlertsService.name);

  /** Envío al webhook de alertas; las pruebas lo reemplazan. */
  send: (url: string, body: string) => Promise<void> = postJson;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async raise(a: AlertInput): Promise<{ id: string; created: boolean }> {
    const { rows: [row] } = await this.pool.query<{ id: string; created: boolean; escalated: boolean }>(
      `WITH prev AS (SELECT severity FROM platform.alerts WHERE dedupe_key = $6 AND acknowledged_at IS NULL)
       INSERT INTO platform.alerts (id, severity, kind, title, detail, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) WHERE acknowledged_at IS NULL
       DO UPDATE SET occurrences = platform.alerts.occurrences + 1, last_seen_at = now(), title = EXCLUDED.title, detail = EXCLUDED.detail,
                     severity = CASE WHEN ${RANK('EXCLUDED.severity')} < ${RANK('platform.alerts.severity')} THEN EXCLUDED.severity ELSE platform.alerts.severity END
       RETURNING id, (xmax = 0) AS created,
                 COALESCE(${RANK('$2')} < (SELECT ${RANK('prev.severity')} FROM prev), false) AS escalated`,
      [`alr_${randomBytes(10).toString('hex')}`, a.severity, a.kind, a.title, JSON.stringify(a.detail ?? {}), a.dedupeKey]);
    const line = `${a.severity.toUpperCase()} ${a.kind}: ${a.title}`;
    if (a.severity === 'critical') this.log.error(line); else this.log.warn(line);
    const url = process.env.ALERT_WEBHOOK_URL;
    // Se envía la primera vez y cuando sube de gravedad (de atención a crítica)
    if ((row.created || row.escalated) && url) {
      try {
        await this.send(url, JSON.stringify({ text: alertText(a), alert: { id: row.id, ...a } }));
        await this.pool.query('UPDATE platform.alerts SET delivered_at = now() WHERE id = $1', [row.id]);
      } catch (e) {
        this.log.error(`No se pudo enviar la alerta ${row.id}: ${(e as Error).message}`);
        await this.pool.query('UPDATE platform.alerts SET delivery_error = $2 WHERE id = $1', [row.id, (e as Error).message.slice(0, 300)]);
      }
    }
    return { id: row.id, created: row.created };
  }

  async open(limit = 50) {
    const { rows } = await this.pool.query(
      `SELECT id, severity, kind, title, detail, occurrences, created_at, last_seen_at, delivered_at, delivery_error
         FROM platform.alerts WHERE acknowledged_at IS NULL
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen_at DESC LIMIT $1`, [limit]);
    return rows;
  }

  async acknowledge(id: string, actor: string) {
    const res = await this.pool.query(
      'UPDATE platform.alerts SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL', [id, actor]);
    if (res.rowCount === 0) throw new ApiError(404, 'resource_missing', `No hay una alerta abierta ${id}`);
    return { id, acknowledged: true };
  }
}

async function postJson(url: string, body: string) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ALERT_WEBHOOK_URL respondió ${res.status}`);
}
