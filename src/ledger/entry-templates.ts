import { Currency, allocateByBps, applyBps } from '../common/money';
import { convertWithQuote, FrozenQuote } from '../fx/fx.math';
import { Accounts } from './chart-of-accounts';
import { EntryDraft, PostingLine, assertBalanced } from './ledger.types';

/** Plantillas de asientos. Puras: reciben datos, devuelven partidas cuadradas. */

export interface CapturedPayment {
  paymentIntentId: string;
  merchantId: string;
  rail: string;
  chargeCurrency: Currency;
  chargeAmount: bigint;
  feeAmount: bigint;
  taxAmount: bigint;
  netAmount: bigint;
  /** IGTF retenido (divisas en efectivo); 0 en los demás métodos. */
  igtfAmount?: bigint;
  fxRate?: string | null;
}

function nonZero(lines: PostingLine[]): PostingLine[] {
  return lines.filter((l) => l.amount !== 0n);
}

/**
 * Cobro aprobado por el riel (PaymentIntent → succeeded). Ej. 100 USD cobrados
 * por Pago Móvil a 36,5 Bs/USD = 3.650,00 Bs:
 *   Dr  platform:rail_clearing:ves_c2p:VES   3.650,00   (el banco nos debe el bruto)
 *   Cr  merchant:m_1:pending:VES            -3.584,38   (neto del comercio, por recibir)
 *   Cr  platform:fee_revenue:VES               -56,57   (1,5 % + 0,05 USD)
 *   Cr  platform:tax_payable:iva:VES            -9,05   (IVA 16 % sobre la comisión)
 * En divisas en efectivo se agrega Cr platform:tax_payable:igtf:USD (3 % que pagó el pagador encima del precio).
 */
export function paymentCaptureEntry(p: CapturedPayment): EntryDraft {
  const c = p.chargeCurrency;
  const lines = nonZero([
    { accountCode: Accounts.railClearing(p.rail, c), currency: c, amount: p.chargeAmount },
    { accountCode: Accounts.merchantPending(p.merchantId, c), currency: c, amount: -p.netAmount },
    { accountCode: Accounts.feeRevenue(c), currency: c, amount: -p.feeAmount },
    { accountCode: Accounts.taxPayable('iva', c), currency: c, amount: -p.taxAmount },
    { accountCode: Accounts.taxPayable('igtf', c), currency: c, amount: -(p.igtfAmount ?? 0n) },
  ]);
  assertBalanced(lines);
  return {
    idempotencyKey: `capture:${p.paymentIntentId}`,
    kind: 'payment_capture',
    referenceType: 'payment_intent',
    referenceId: p.paymentIntentId,
    description: `Captura ${p.paymentIntentId}`,
    metadata: { fx_rate: p.fxRate ?? null },
    lines,
  };
}

/**
 * El riel/banco nos acreditó un lote (conciliación de archivo de cierre o API de movimientos).
 *   Dr cash / Cr rail_clearing           (bruto)
 *   Dr merchant pending / Cr available   (neto de cada comercio: ya se le puede liquidar)
 */
export function railFundsReceivedEntry(
  batchId: string,
  rail: string,
  currency: Currency,
  payments: Array<Pick<CapturedPayment, 'merchantId' | 'chargeAmount' | 'netAmount'>>,
): EntryDraft {
  if (payments.length === 0) throw new Error('Lote de conciliación vacío');
  const gross = payments.reduce((s, p) => s + p.chargeAmount, 0n);
  const netByMerchant = new Map<string, bigint>();
  for (const p of payments) netByMerchant.set(p.merchantId, (netByMerchant.get(p.merchantId) ?? 0n) + p.netAmount);

  const lines: PostingLine[] = [
    { accountCode: Accounts.cash(currency), currency, amount: gross },
    { accountCode: Accounts.railClearing(rail, currency), currency, amount: -gross },
  ];
  for (const [merchantId, net] of [...netByMerchant].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      { accountCode: Accounts.merchantPending(merchantId, currency), currency, amount: net },
      { accountCode: Accounts.merchantAvailable(merchantId, currency), currency, amount: -net },
    );
  }
  assertBalanced(lines);
  return {
    idempotencyKey: `funds:${rail}:${batchId}`,
    kind: 'rail_funds_received',
    referenceType: 'rail_batch',
    referenceId: batchId,
    description: `Fondos recibidos de ${rail}, lote ${batchId}`,
    lines,
  };
}

export interface PayoutSplit {
  currency: Currency;
  /** Porcentaje en bps; todas las porciones suman 10.000. */
  bps: number;
  /** Cotización congelada si currency ≠ moneda origen. */
  quote?: FrozenQuote;
  /** Spread cambiario cobrado sobre la porción convertida (120 = 1,2 %). */
  spreadBps?: number;
}

export interface PayoutLeg {
  currency: Currency;
  /** Porción en moneda origen, antes del spread. */
  sourceAmount: bigint;
  spread: bigint;
  /** Lo que recibe el comercio en `currency`. */
  amount: bigint;
  rate: string | null;
  spreadBps: number;
}

/**
 * Liquidación al comercio con Split Settlement. Ej. 60 % VES / 40 % USDT de 3.584,38 Bs,
 * USDT a 38,2 Bs y spread 1,2 %:
 *   Dr merchant:m_1:available:VES   2.150,62 / Cr platform:cash:VES               -2.150,62
 *   Dr merchant:m_1:available:VES   1.433,76 / Cr platform:fx_spread_revenue:VES     -17,21
 *                                             Cr platform:fx_position:VES         -1.416,55
 *   Dr platform:fx_position:USDT   37,082461 / Cr platform:cash:USDT             -37,082461
 * El spread se registra como ingreso visible, no escondido en la tasa: la tasa
 * aplicada es la de mercado y el comercio ve exactamente cuánto se le cobró.
 */
export function merchantPayoutEntry(
  idempotencyKey: string,
  payoutId: string,
  merchantId: string,
  sourceCurrency: Currency,
  amount: bigint,
  splits: PayoutSplit[],
): { draft: EntryDraft; legs: PayoutLeg[] } {
  if (amount <= 0n) throw new Error('Monto de liquidación debe ser positivo');
  const parts = allocateByBps(amount, splits.map((s) => s.bps));
  const lines: PostingLine[] = [];
  const legs: PayoutLeg[] = [];
  const available = Accounts.merchantAvailable(merchantId, sourceCurrency);

  splits.forEach((split, i) => {
    const part = parts[i];
    if (part === 0n) return;
    if (split.currency === sourceCurrency) {
      lines.push(
        { accountCode: available, currency: sourceCurrency, amount: part },
        { accountCode: Accounts.cash(sourceCurrency), currency: sourceCurrency, amount: -part },
      );
      legs.push({ currency: sourceCurrency, sourceAmount: part, spread: 0n, amount: part, rate: null, spreadBps: 0 });
      return;
    }
    if (!split.quote) throw new Error(`Falta cotización para liquidar ${sourceCurrency}→${split.currency}`);
    const spreadBps = split.spreadBps ?? 0;
    const spread = applyBps(part, spreadBps);
    const convertible = part - spread;
    const converted = convertWithQuote(convertible, sourceCurrency, split.currency, split.quote);
    if (converted === 0n) throw new Error(`La porción en ${split.currency} redondea a cero`);
    lines.push(
      { accountCode: available, currency: sourceCurrency, amount: part },
      { accountCode: Accounts.fxSpreadRevenue(sourceCurrency), currency: sourceCurrency, amount: -spread },
      { accountCode: Accounts.fxPosition(sourceCurrency), currency: sourceCurrency, amount: -convertible, fxRate: split.quote.rate },
      { accountCode: Accounts.fxPosition(split.currency), currency: split.currency, amount: converted, fxRate: split.quote.rate },
      { accountCode: Accounts.cash(split.currency), currency: split.currency, amount: -converted },
    );
    legs.push({ currency: split.currency, sourceAmount: part, spread, amount: converted, rate: split.quote.rate, spreadBps });
  });

  const nonZeroLines = lines.filter((l) => l.amount !== 0n);
  assertBalanced(nonZeroLines);
  return {
    draft: {
      idempotencyKey,
      kind: 'merchant_payout',
      referenceType: 'payout',
      referenceId: payoutId,
      description: `Liquidación ${payoutId} a ${merchantId}`,
      metadata: {
        legs: legs.map((l) => ({ ...l, sourceAmount: l.sourceAmount.toString(), spread: l.spread.toString(), amount: l.amount.toString() })),
        quotes: splits.filter((s) => s.quote).map((s) => s.quote!.id),
      },
      lines: nonZeroLines,
    },
    legs,
  };
}
