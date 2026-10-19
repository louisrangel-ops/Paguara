import { Currency } from '../common/money';

export type PaymentMethodType =
  | 'pago_movil_c2p'
  | 'pago_movil_p2p'
  | 'debito_inmediato'
  | 'card_national'
  | 'card_international'
  | 'zelle'
  | 'banesco_panama'
  | 'usdt_trc20'
  | 'usdt_polygon'
  | 'cash';

export interface MethodConfig {
  rail: string;
  chargeCurrency: Currency;
  /** MDR porcentual en puntos básicos (150 = 1,50 %). */
  feeBps: number;
  /** Comisión fija en USD (unidades mínimas), convertida a la moneda del cobro con la tasa congelada (USDT: tasa del exchange). */
  feeFixedUsd: bigint;
  /** IVA sobre la comisión, en bps (1600 = 16 %). Solo rieles locales en VES. */
  feeTaxBps: number;
  /**
   * IGTF en bps (300 = 3 %). Solo aplica a pagos en divisas en efectivo; lo
   * paga el pagador encima del precio y la plataforma lo retiene para el SENIAT.
   */
  igtfBps: number;
  /** Validez de la tasa mostrada al pagador antes de confirmar. */
  quoteTtlSeconds: number;
}

/** Precios de plataforma (documento de diseño, sección 4). Cada comercio puede tener los suyos en merchants.capabilities. */
export const PAYMENT_METHODS: Record<PaymentMethodType, MethodConfig> = {
  pago_movil_c2p:     { rail: 'ves_c2p',        chargeCurrency: 'VES',  feeBps: 150, feeFixedUsd: 5n,  feeTaxBps: 1600, igtfBps: 0,   quoteTtlSeconds: 300 },
  pago_movil_p2p:     { rail: 'ves_p2p',        chargeCurrency: 'VES',  feeBps: 150, feeFixedUsd: 5n,  feeTaxBps: 1600, igtfBps: 0,   quoteTtlSeconds: 900 },
  debito_inmediato:   { rail: 'ves_debito_inm', chargeCurrency: 'VES',  feeBps: 150, feeFixedUsd: 5n,  feeTaxBps: 1600, igtfBps: 0,   quoteTtlSeconds: 300 },
  card_national:      { rail: 'ves_card_switch', chargeCurrency: 'VES', feeBps: 380, feeFixedUsd: 0n,  feeTaxBps: 1600, igtfBps: 0,   quoteTtlSeconds: 300 },
  card_international: { rail: 'offshore_card',  chargeCurrency: 'USD',  feeBps: 490, feeFixedUsd: 40n, feeTaxBps: 0,    igtfBps: 0,   quoteTtlSeconds: 900 },
  zelle:              { rail: 'zelle',          chargeCurrency: 'USD',  feeBps: 250, feeFixedUsd: 25n, feeTaxBps: 0,    igtfBps: 0,   quoteTtlSeconds: 1800 },
  banesco_panama:     { rail: 'banesco_panama', chargeCurrency: 'USD', feeBps: 250, feeFixedUsd: 25n, feeTaxBps: 0,    igtfBps: 0,   quoteTtlSeconds: 900 },
  usdt_trc20:         { rail: 'usdt_trc20',     chargeCurrency: 'USDT', feeBps: 120, feeFixedUsd: 10n, feeTaxBps: 0,    igtfBps: 0,   quoteTtlSeconds: 1800 },
  usdt_polygon:       { rail: 'usdt_polygon',   chargeCurrency: 'USDT', feeBps: 120, feeFixedUsd: 10n, feeTaxBps: 0,    igtfBps: 0,   quoteTtlSeconds: 1800 },
  cash:               { rail: 'cash_network',   chargeCurrency: 'USD',  feeBps: 200, feeFixedUsd: 25n, feeTaxBps: 0,    igtfBps: 300, quoteTtlSeconds: 86400 },
};

/** Nombre para el pagador y el panel. */
export const METHOD_NAMES: Record<PaymentMethodType, string> = {
  pago_movil_c2p: 'Pago Móvil C2P', pago_movil_p2p: 'Pago Móvil P2P', debito_inmediato: 'Débito inmediato',
  card_national: 'Tarjeta nacional', card_international: 'Tarjeta internacional', zelle: 'Zelle',
  banesco_panama: 'Banesco Panamá', usdt_trc20: 'USDT TRC-20', usdt_polygon: 'USDT Polygon', cash: 'Efectivo en dólares',
};

export function isPaymentMethodType(v: unknown): v is PaymentMethodType {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, v);
}

/** Fuente de tasa por defecto para cada par (base/quote). El comercio podrá elegir otra. */
export function defaultRateSource(a: Currency, b: Currency): string {
  const pair = [a, b].sort().join('/');
  if (pair === 'USDT/VES') return 'BINANCE_P2P';
  if (pair === 'USD/USDT') return 'EXCHANGE'; // la tasa que dé el exchange que use la plataforma
  return 'BCV';
}
