import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidTransitionError, PaymentIntentEventType, PaymentIntentStatus, TERMINAL_STATUSES, canApply, nextStatus,
} from '../../src/payment-intents/payment-intent.state-machine';

const STATUSES: PaymentIntentStatus[] = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'succeeded', 'settled', 'canceled'];
const EVENTS: PaymentIntentEventType[] = ['attach_payment_method', 'confirm', 'require_action', 'action_completed', 'rail_succeeded', 'rail_failed', 'settle', 'cancel'];

test('camino feliz síncrono (Pago Móvil C2P)', () => {
  let s: PaymentIntentStatus = 'requires_payment_method';
  for (const [e, expected] of [['attach_payment_method', 'requires_confirmation'], ['confirm', 'processing'],
    ['rail_succeeded', 'succeeded'], ['settle', 'settled']] as const) {
    s = nextStatus(s, e);
    assert.equal(s, expected);
  }
});

test('camino con acción del pagador (P2P, Zelle, USDT, 3DS)', () => {
  let s = nextStatus('processing', 'require_action');
  assert.equal(s, 'requires_action');
  s = nextStatus(s, 'action_completed');
  assert.equal(nextStatus(s, 'rail_succeeded'), 'succeeded');
});

test('un rechazo vuelve a requires_payment_method para reintentar con otro método', () => {
  assert.equal(nextStatus('processing', 'rail_failed'), 'requires_payment_method');
  assert.equal(nextStatus('requires_action', 'rail_failed'), 'requires_payment_method');
});

test('no se puede cancelar con dinero en vuelo ni después de cobrar', () => {
  for (const s of ['processing', 'succeeded', 'settled'] as const) assert.equal(canApply(s, 'cancel'), false);
});

test('no se puede liquidar algo no cobrado ni cobrar dos veces', () => {
  assert.throws(() => nextStatus('processing', 'settle'), InvalidTransitionError);
  assert.throws(() => nextStatus('succeeded', 'rail_succeeded'), InvalidTransitionError);
  assert.throws(() => nextStatus('requires_confirmation', 'rail_succeeded'), InvalidTransitionError);
});

test('los estados terminales no aceptan ningún evento', () => {
  for (const s of TERMINAL_STATUSES) for (const e of EVENTS) assert.equal(canApply(s, e), false, `${s} + ${e}`);
});

test('todo estado no terminal tiene salida', () => {
  for (const s of STATUSES.filter((x) => !TERMINAL_STATUSES.has(x))) {
    assert.ok(EVENTS.some((e) => canApply(s, e) && nextStatus(s, e) !== s), s);
  }
});
