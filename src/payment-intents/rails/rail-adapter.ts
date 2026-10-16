import { Currency } from '../../common/money';
import { PaymentMethodType } from '../payment-methods';

export const RAIL_ADAPTERS = Symbol('RAIL_ADAPTERS');

export interface RailChargeRequest {
  paymentIntentId: string;
  /** Llave de idempotencia hacia el banco/procesador: cambia en cada intento. */
  attemptKey: string;
  method: PaymentMethodType;
  currency: Currency;
  amount: bigint;
  details: Record<string, unknown>;
}

/** Respuesta normalizada; cada conector traduce ISO 8583 / SOAP / REST a esto. */
export type RailResult =
  | { status: 'succeeded'; reference: string }
  | { status: 'pending'; reference: string }
  | { status: 'requires_action'; reference?: string; nextAction: Record<string, unknown> }
  | { status: 'failed'; code: RailDeclineCode; message: string; reference?: string };

export type RailDeclineCode =
  | 'insufficient_funds'
  | 'do_not_honor'
  | 'invalid_c2p_token'
  | 'invalid_account'
  | 'bank_unavailable'
  | 'action_expired'
  | 'card_declined'
  | 'processing_error';

export interface RailAdapter {
  readonly rail: string;
  charge(req: RailChargeRequest): Promise<RailResult>;
}
