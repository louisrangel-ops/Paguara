import { Currency, convert, divRoundHalfEven, CURRENCY_EXPONENT, parseRate, RATE_SCALE } from '../common/money';

/** Cotización congelada: 1 base = rate quote. */
export interface FrozenQuote {
  id: string;
  base: Currency;
  quote: Currency;
  rate: string;
  source: string;
  expiresAt: Date;
}

/**
 * Convierte con una cotización en cualquiera de los dos sentidos, sin invertir
 * la tasa (invertir 36.5 a 0.027397... perdería precisión):
 *   USD→VES con cotización USD/VES: multiplica
 *   VES→USD con cotización USD/VES: divide
 */
export function convertWithQuote(amount: bigint, from: Currency, to: Currency, q: Pick<FrozenQuote, 'base' | 'quote' | 'rate'>): bigint {
  if (from === to) return amount;
  if (q.base === from && q.quote === to) return convert(amount, from, to, q.rate);
  if (q.base === to && q.quote === from) {
    if (amount < 0n) throw new Error('convertWithQuote: monto negativo');
    // amount_to = amount_from / rate, ajustando exponentes
    const expDiff = CURRENCY_EXPONENT[to] - CURRENCY_EXPONENT[from];
    let num = amount * 10n ** BigInt(RATE_SCALE);
    let den = parseRate(q.rate);
    if (expDiff >= 0) num *= 10n ** BigInt(expDiff);
    else den *= 10n ** BigInt(-expDiff);
    return divRoundHalfEven(num, den);
  }
  throw new Error(`La cotización ${q.base}/${q.quote} no sirve para convertir ${from}→${to}`);
}
