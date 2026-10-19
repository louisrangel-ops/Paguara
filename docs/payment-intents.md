# Máquina de estados del PaymentIntent

Código: `src/payment-intents/payment-intent.state-machine.ts` (decide), `payment-intent.repository.ts` (aplica),
`payment-intents.service.ts` (orquesta). Esquema: migraciones 003, 005 y 007.

```
requires_payment_method ─attach─▶ requires_confirmation ─confirm─▶ processing ─rail_succeeded─▶ succeeded ─settle─▶ settled
         ▲                                                          │    ▲
         │                                                          ▼    │ action_completed
         └──────────────────── rail_failed ◀──────────────── requires_action
cancel: desde requires_payment_method, requires_confirmation o requires_action
```

## Tabla de transiciones

| Desde | Evento | Hacia |
|---|---|---|
| `requires_payment_method` | `attach_payment_method` | `requires_confirmation` |
| `requires_payment_method` | `cancel` | `canceled` |
| `requires_confirmation` | `attach_payment_method` | `requires_confirmation` (cambiar método o re-cotizar) |
| `requires_confirmation` | `confirm` | `processing` |
| `requires_confirmation` | `cancel` | `canceled` |
| `processing` | `require_action` | `requires_action` |
| `processing` | `rail_succeeded` | `succeeded` |
| `processing` | `rail_failed` | `requires_payment_method` |
| `requires_action` | `action_completed` | `processing` |
| `requires_action` | `rail_failed` | `requires_payment_method` |
| `requires_action` | `cancel` | `canceled` |
| `succeeded` | `settle` | `settled` |

`settled` y `canceled` son terminales. La misma tabla (sin el bucle de `requires_confirmation`) está en
`payments.allowed_transitions`, y una prueba de integración verifica que coincidan
(`allowedStatusChanges()`). Un evento no permitido lanza `InvalidTransitionError` → 409 `payment_intent_unexpected_state`.

No hay estados `failed`, `refunded` ni `disputed`: un rechazo vuelve a `requires_payment_method` con
`last_payment_error` para reintentar; reembolsos y contracargos serán objetos propios (**pendiente**).

## Pasos

**Crear** (`create`): valida monto > 0, moneda soportada y `expires_in` entre 60 s y 30 días (24 h por defecto).
Acepta `payment_method_types` (lista de métodos permitidos en ese pago): cada uno debe estar `active` en el comercio
(400 `payment_method_not_allowed`); sin lista, el comercio debe tener al menos un método activo (400 `no_payment_methods_available`).
Genera `pi_…` y `client_secret`. Si `(comercio, Idempotency-Key)` ya existe devuelve el existente; si el monto
o la moneda difieren → 422 `idempotency_key_reused`. Registra la transición `create` y el evento `payment_intent.created`.

**Adjuntar método** (`attachPaymentMethod`): toma lock, rechaza si venció (409 `payment_intent_expired`).
El método debe estar en la lista del pago, si la tiene (400 `payment_method_not_allowed`), y `active` en el comercio
(403 `payment_method_disabled`); el monto en moneda de cobro debe respetar sus `min_amount`/`max_amount` (400 `amount_out_of_range`).
Usa el precio negociado del comercio si existe ([modulos-por-comercio.md](modulos-por-comercio.md)). Fija riel y moneda de cobro del método. Si la moneda del precio difiere, congela una cotización con el TTL del
método ([fx.md](fx.md)) y convierte. Lleva la comisión fija (definida en USD) a la moneda del cobro y calcula el
desglose ([metodos-de-pago.md](metodos-de-pago.md)). Puede repetirse mientras no se confirme.

**Confirmar** (`confirm`): en una transacción corta valida vencimiento, desde `requires_confirmation` repite el chequeo
del método (el comercio pudo apagarlo después de `attach`; lo que ya está en `processing` o `requires_action` no se toca) y que la cotización no haya vencido
(409 `fx_quote_expired`: hay que volver a adjuntar) y persiste `processing`. **Luego**, fuera de la transacción,
llama al riel con `attemptKey = <pi_id>_<version>`. Los `payment_method_details` (OTP, tokens) se pasan al riel
y no se guardan. Si el riel no responde (excepción, timeout), el intent queda en `processing` para el reconciliador
(**pendiente**): marcarlo fallido podría duplicar un cobro.

**Resultado del riel** (`applyRailResult`): la respuesta síncrona o `POST /internal/payment_intents/:id/rail_result`.
- `succeeded`: si estaba en `requires_action` pasa primero por `action_completed`; en `processing` registra el
  asiento de captura y la transición `rail_succeeded` en la **misma transacción**. Si ya está `succeeded`/`settled`, no hace nada.
- `requires_action`: guarda `next_action` (instrucciones para el pagador).
- `pending`: solo actualiza `rail_reference`.
- `failed`: vuelve a `requires_payment_method` con `last_payment_error {code, message, rail, rail_reference}`.
- Un resultado que no aplica al estado actual se ignora y se registra en el log (nivel `error` si es un éxito tardío: requiere revisión manual).

**Cancelar** (`cancel`): solo antes de que se mueva dinero.

**Vencer** (`expireStale`, `POST /internal/payment_intents/expire`): cancela con motivo `expired` hasta 500 intents
vencidos en `requires_payment_method` o `requires_confirmation`. Los de `requires_action` no se tocan: el pagador
pudo haber enviado la transferencia.

**Liquidar**: `succeeded → settled` en el corte de lote ([liquidaciones.md](liquidaciones.md)).

## Tasa congelada

Desde `processing` (y en `requires_action`, `succeeded`, `settled`) no cambian `charge_amount`, `charge_currency`,
`fx_rate`, `fx_quote_id`, comisión, IVA, neto, IGTF, riel ni método (`FX_FROZEN_STATUSES`; en la BD, trigger `pi_guard` → `P0012`).
La API lo expone como `fx.frozen: true`.

## Garantías contra doble cobro

1. Redis: `Idempotency-Key` en todo POST de la API v1 ([api.md](api.md#idempotencia)).
2. Lock de fila `FOR UPDATE` en cada transición y control de `version`.
3. Llave única del asiento de captura (`capture:<pi_id>`).
4. Índice único `(rail, rail_reference)`: la misma referencia bancaria no confirma dos pagos.

## Auditoría

Cada cambio deja una fila en `payments.payment_intent_transitions` (desde, hacia, evento, actor, detalles,
asiento). Actores: `merchant:<id>`, `payment_link:<id>`, `rail:<riel>`, `worker:<fuente>`, `system:expiry`, `settlement`.
El dashboard la muestra como línea de tiempo.

## Webhooks que emite

| Cambio | Evento |
|---|---|
| Creación | `payment_intent.created` |
| `rail_failed` | `payment_intent.payment_failed` |
| → `requires_action` | `payment_intent.requires_action` |
| → `succeeded` | `payment_intent.succeeded` |
| → `canceled` | `payment_intent.canceled` |
| → `settled` | `payment_intent.settled` |

Se encolan en la misma transacción (outbox, ver [webhooks.md](webhooks.md)) y llevan la vista de la API sin `client_secret`.
