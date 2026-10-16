/**
 * Máquina de estados de un PaymentIntent. Función pura: decide, no ejecuta.
 * La misma tabla vive en SQL (payments.allowed_transitions) y un test de
 * integración verifica que ambas coincidan.
 *
 *   requires_payment_method ─attach─▶ requires_confirmation ─confirm─▶ processing ─▶ succeeded ─settle─▶ settled
 *            ▲                                                       │   ▲
 *            │                                                       ▼   │
 *            └───────────── rail_failed ◀─────────────────── requires_action
 *
 * `processing` se persiste ANTES de llamar al riel: si el proceso muere a mitad
 * de la llamada, el intent queda en un estado que el reconciliador revisa, y la
 * tasa ya está congelada.
 */
export type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'settled'
  | 'canceled';

export type PaymentIntentEventType =
  /** Se elige el método; se calcula el monto en la moneda del riel y se cotiza la tasa. */
  | 'attach_payment_method'
  /** El pagador confirma: se congela la cotización y arranca el cobro en el riel. */
  | 'confirm'
  /** El riel pide algo al pagador: OTP C2P, 3DS, transferir P2P/Zelle, enviar USDT. */
  | 'require_action'
  /** El pagador cumplió la acción; el riel vuelve a procesar. */
  | 'action_completed'
  /** El riel confirmó los fondos: se registra el asiento de captura. */
  | 'rail_succeeded'
  /** El riel rechazó o la acción expiró: vuelve a requires_payment_method con last_payment_error. */
  | 'rail_failed'
  /** Se liquidó al comercio en un lote de pago. */
  | 'settle'
  | 'cancel';

const TRANSITIONS: Record<PaymentIntentStatus, Partial<Record<PaymentIntentEventType, PaymentIntentStatus>>> = {
  requires_payment_method: {
    attach_payment_method: 'requires_confirmation',
    cancel: 'canceled',
  },
  requires_confirmation: {
    attach_payment_method: 'requires_confirmation', // cambiar de método o re-cotizar
    confirm: 'processing',
    cancel: 'canceled',
  },
  processing: {
    require_action: 'requires_action',
    rail_succeeded: 'succeeded',
    rail_failed: 'requires_payment_method',
  },
  requires_action: {
    action_completed: 'processing',
    rail_failed: 'requires_payment_method',
    cancel: 'canceled',
  },
  succeeded: {
    settle: 'settled',
  },
  settled: {},
  canceled: {},
};

export const TERMINAL_STATUSES: ReadonlySet<PaymentIntentStatus> = new Set(['settled', 'canceled']);

/** Estados en los que monto cobrado, moneda y tasa ya no pueden cambiar (la BD lo vuelve a exigir). */
export const FX_FROZEN_STATUSES: ReadonlySet<PaymentIntentStatus> = new Set([
  'processing',
  'requires_action',
  'succeeded',
  'settled',
]);

export class InvalidTransitionError extends Error {
  readonly code = 'payment_intent_unexpected_state';
  constructor(
    readonly from: PaymentIntentStatus,
    readonly event: PaymentIntentEventType,
  ) {
    super(`No se puede aplicar "${event}" a un PaymentIntent en estado "${from}"`);
  }
}

export function nextStatus(from: PaymentIntentStatus, event: PaymentIntentEventType): PaymentIntentStatus {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export function canApply(from: PaymentIntentStatus, event: PaymentIntentEventType): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

/** Pares (desde, hacia) con cambio real de estado; espejo de payments.allowed_transitions. */
export function allowedStatusChanges(): Array<[PaymentIntentStatus, PaymentIntentStatus]> {
  const pairs = new Set<string>();
  for (const [from, events] of Object.entries(TRANSITIONS)) {
    for (const to of Object.values(events)) if (to && to !== from) pairs.add(`${from}>${to}`);
  }
  return [...pairs].sort().map((p) => p.split('>') as [PaymentIntentStatus, PaymentIntentStatus]);
}
