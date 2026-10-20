import { Pool } from 'pg';
import { Currency } from '../common/money';
import { StatementSource } from './reconciliation.service';
import { BankMovement } from './statement-parser';

/**
 * Banco simulado del sandbox: su "extracto" del día son los cobros que el riel
 * de prueba aprobó, acreditados por el monto exacto y con su referencia. Así el
 * job diario corre de punta a punta en desarrollo y sandbox, y libera los
 * fondos para el corte. Nunca se usa con LIVEMODE=true.
 */
export class SandboxStatementSource implements StatementSource {
  readonly kind = 'sandbox' as const;

  constructor(readonly rail: string, private readonly pool: Pool) {}

  async fetch(currency: Currency, date: string): Promise<BankMovement[]> {
    const { rows } = await this.pool.query<{ rail_reference: string; charge_amount: bigint; id: string }>(
      `SELECT rail_reference, charge_amount, id FROM payments.payment_intents
        WHERE rail = $1 AND charge_currency = $2 AND capture_entry_id IS NOT NULL AND rail_reference IS NOT NULL
          AND (succeeded_at AT TIME ZONE 'America/Caracas')::date = $3::date ORDER BY succeeded_at, id`, [this.rail, currency, date]);
    return rows.map((r) => ({ valueDate: date, amount: r.charge_amount, reference: r.rail_reference, description: `Sandbox ${r.id}` }));
  }
}
