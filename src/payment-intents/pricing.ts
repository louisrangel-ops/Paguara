import { applyBps } from '../common/money';
import { MethodConfig } from './payment-methods';

export interface ChargeBreakdown {
  /** Total que paga el pagador: precio convertido + IGTF. */
  charge: bigint;
  fee: bigint;
  tax: bigint;
  igtf: bigint;
  net: bigint;
}

export class AmountTooSmallError extends Error {
  readonly code = 'amount_too_small';
}

/**
 * A partir del precio ya convertido a la moneda del cobro:
 *   comisión = precio × bps + fijo        IVA = comisión × 16 % (rieles VES)
 *   IGTF     = precio × 3 % (solo divisas en efectivo), se cobra ENCIMA del precio
 *   neto     = precio − comisión − IVA    (lo que recibe el comercio)
 *   charge   = precio + IGTF = comisión + IVA + neto + IGTF (la BD también lo verifica)
 */
export function computeBreakdown(price: bigint, method: MethodConfig, fixedFeeInChargeCurrency: bigint): ChargeBreakdown {
  const fee = applyBps(price, method.feeBps) + fixedFeeInChargeCurrency;
  const tax = applyBps(fee, method.feeTaxBps);
  const igtf = applyBps(price, method.igtfBps);
  const net = price - fee - tax;
  if (net <= 0n) throw new AmountTooSmallError('El monto no cubre la comisión del método de pago');
  return { charge: price + igtf, fee, tax, igtf, net };
}
