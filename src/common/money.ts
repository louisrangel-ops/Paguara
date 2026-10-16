/**
 * Dinero en unidades mínimas (bigint) y conversión con tasas decimales exactas.
 * Nada de float: 0.1 + 0.2 no existe aquí.
 */
export type Currency = 'VES' | 'USD' | 'EUR' | 'USDT';

export const CURRENCY_EXPONENT: Record<Currency, number> = {
  VES: 2,
  USD: 2,
  EUR: 2,
  USDT: 6,
};

export function isCurrency(value: string): value is Currency {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, value);
}

/** Escala fija de las tasas: 12 decimales, igual que numeric(30,12) en PostgreSQL. */
export const RATE_SCALE = 12;
const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);

/** "36.5" → 36500000000000n (tasa escalada a 12 decimales). Rechaza más precisión de la representable. */
export function parseRate(rate: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!m) throw new Error(`Tasa inválida: "${rate}"`);
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > RATE_SCALE) throw new Error(`Tasa con más de ${RATE_SCALE} decimales: "${rate}"`);
  const scaled = BigInt(m[1]) * RATE_FACTOR + BigInt(frac.padEnd(RATE_SCALE, '0') || '0');
  if (scaled <= 0n) throw new Error(`La tasa debe ser positiva: "${rate}"`);
  return scaled;
}

export function formatRate(scaled: bigint): string {
  const int = scaled / RATE_FACTOR;
  const frac = (scaled % RATE_FACTOR).toString().padStart(RATE_SCALE, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : `${int}`;
}

/** División entera con redondeo bancario (half-even). Solo numerador ≥ 0, denominador > 0. */
export function divRoundHalfEven(num: bigint, den: bigint): bigint {
  if (num < 0n || den <= 0n) throw new Error('divRoundHalfEven: numerador ≥ 0 y denominador > 0');
  const q = num / den;
  const r = num % den;
  const twice = r * 2n;
  if (twice > den || (twice === den && q % 2n === 1n)) return q + 1n;
  return q;
}

/**
 * Convierte `amount` (unidades mínimas de `from`) a unidades mínimas de `to`
 * con 1 `from` = `rate` `to`.
 *   convert(10000n, 'USD', 'VES', '36.5') === 365000n   // 100,00 USD → 3.650,00 Bs
 */
export function convert(amount: bigint, from: Currency, to: Currency, rate: string): bigint {
  if (amount < 0n) throw new Error('convert: monto negativo');
  if (from === to) return amount;
  const expDiff = CURRENCY_EXPONENT[to] - CURRENCY_EXPONENT[from];
  let num = amount * parseRate(rate);
  let den = RATE_FACTOR;
  if (expDiff >= 0) num *= 10n ** BigInt(expDiff);
  else den *= 10n ** BigInt(-expDiff);
  return divRoundHalfEven(num, den);
}

/** Porcentaje en puntos básicos (150 bps = 1,50 %), redondeo half-even. */
export function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`bps inválido: ${bps}`);
  return divRoundHalfEven(amount * BigInt(bps), 10_000n);
}

/**
 * Reparte `total` según pesos en bps (deben sumar 10.000) sin perder ni crear
 * un céntimo: el residuo de redondeo se asigna a la última porción.
 */
export function allocateByBps(total: bigint, weightsBps: number[]): bigint[] {
  const sum = weightsBps.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) throw new Error(`Los porcentajes deben sumar 100 % (suman ${sum / 100} %)`);
  const parts = weightsBps.map((w) => (total * BigInt(w)) / 10_000n);
  const assigned = parts.reduce((a, b) => a + b, 0n);
  parts[parts.length - 1] += total - assigned;
  return parts;
}

export function formatMinor(amount: bigint, currency: Currency): string {
  const exp = CURRENCY_EXPONENT[currency];
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const factor = 10n ** BigInt(exp);
  const int = abs / factor;
  const frac = exp ? '.' + (abs % factor).toString().padStart(exp, '0') : '';
  return `${neg ? '-' : ''}${int}${frac} ${currency}`;
}
