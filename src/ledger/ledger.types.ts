import { Currency } from '../common/money';

export type EntryKind =
  | 'payment_capture'
  | 'rail_funds_received'
  | 'merchant_payout'
  | 'refund'
  | 'fee_adjustment'
  | 'capital_contribution'
  | 'reversal';

/** amount > 0 = débito, amount < 0 = crédito (misma convención que la tabla). */
export interface PostingLine {
  accountCode: string;
  currency: Currency;
  amount: bigint;
  fxRate?: string;
}

export interface EntryDraft {
  idempotencyKey: string;
  kind: EntryKind;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  lines: PostingLine[];
}

export class UnbalancedEntryError extends Error {
  readonly code = 'ledger_unbalanced_entry';
}

/** Validación previa en la app; la BD vuelve a exigirlo al COMMIT. */
export function assertBalanced(lines: PostingLine[]): void {
  if (lines.length < 2) throw new UnbalancedEntryError('Un asiento necesita al menos 2 partidas');
  const totals = new Map<Currency, bigint>();
  for (const l of lines) {
    if (l.amount === 0n) throw new UnbalancedEntryError(`Partida en cero sobre ${l.accountCode}`);
    if (!l.accountCode.endsWith(`:${l.currency}`)) {
      throw new UnbalancedEntryError(`Partida en ${l.currency} sobre cuenta ${l.accountCode}`);
    }
    totals.set(l.currency, (totals.get(l.currency) ?? 0n) + l.amount);
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) throw new UnbalancedEntryError(`El asiento no cuadra en ${currency}: descuadre ${total}`);
  }
}
