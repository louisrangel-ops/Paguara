import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { Currency, parseRate } from '../common/money';
import { PG_POOL } from '../database/database';
import { FrozenQuote } from './fx.math';

export class RateUnavailableError extends Error {
  readonly code = 'fx_rate_unavailable';
}

/** Antigüedad máxima de una tasa observada para poder cotizar con ella. */
const MAX_RATE_AGE_SECONDS = Number(process.env.FX_MAX_RATE_AGE_SECONDS ?? 6 * 3600);

@Injectable()
export class FxService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Registra una tasa observada. Para BCV se exige la fecha efectiva oficial. */
  async recordRate(base: Currency, quote: Currency, rate: string, source: string, observedAt = new Date(), effectiveDate?: string): Promise<string> {
    parseRate(rate);
    if (source === 'BCV' && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate ?? '')) {
      throw new Error('Las tasas BCV requieren effectiveDate YYYY-MM-DD');
    }
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO fx.rates (base_currency, quote_currency, rate, source, observed_at, effective_date)
       VALUES ($1, $2, $3, $4, $5, $6::date) RETURNING id`,
      [base, quote, rate, source, observedAt, effectiveDate ?? null],
    );
    return res.rows[0].id;
  }

  static venezuelaDate(now = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  }

  /**
   * Congela la tasa vigente entre dos monedas (en cualquier dirección) en una
   * cotización inmutable con vencimiento. Lo que se le muestra al pagador es
   * exactamente lo que se cobra.
   */
  async freezeQuote(client: PoolClient, a: Currency, b: Currency, source: string, ttlSeconds: number): Promise<FrozenQuote> {
    const isBcvUsdVes = source === 'BCV' && [a, b].includes('USD') && [a, b].includes('VES');
    const rate = isBcvUsdVes
      ? await client.query<{ id: string; base_currency: Currency; quote_currency: Currency; rate: string }>(
          `SELECT id, base_currency, quote_currency, rate::text AS rate FROM fx.rates
            WHERE source = 'BCV'
              AND ((base_currency = $1 AND quote_currency = $2) OR (base_currency = $2 AND quote_currency = $1))
              AND effective_date <= $3::date
            ORDER BY effective_date DESC, observed_at DESC LIMIT 1`,
          [a, b, FxService.venezuelaDate()],
        )
      : await client.query<{ id: string; base_currency: Currency; quote_currency: Currency; rate: string }>(
          `SELECT id, base_currency, quote_currency, rate::text AS rate FROM fx.rates
            WHERE source = $3
              AND ((base_currency = $1 AND quote_currency = $2) OR (base_currency = $2 AND quote_currency = $1))
              AND observed_at > now() - make_interval(secs => $4)
            ORDER BY observed_at DESC LIMIT 1`,
          [a, b, source, MAX_RATE_AGE_SECONDS],
        );
    if (rate.rowCount === 0) throw new RateUnavailableError(
      isBcvUsdVes
        ? `No hay tasa oficial BCV vigente para ${a}/${b} en ${FxService.venezuelaDate()}`
        : `No hay tasa ${source} reciente para ${a}/${b}`);
    const r = rate.rows[0];
    const id = `fxq_${randomBytes(12).toString('hex')}`;
    const q = await client.query<{ expires_at: Date }>(
      `INSERT INTO fx.quotes (id, rate_id, base_currency, quote_currency, rate, source, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) RETURNING expires_at`,
      [id, r.id, r.base_currency, r.quote_currency, r.rate, source, ttlSeconds],
    );
    return { id, base: r.base_currency, quote: r.quote_currency, rate: normalizeRate(r.rate), source, expiresAt: q.rows[0].expires_at };
  }
}

/** "36.500000000000" → "36.5" */
export function normalizeRate(rate: string): string {
  return rate.includes('.') ? rate.replace(/0+$/, '').replace(/\.$/, '') : rate;
}
