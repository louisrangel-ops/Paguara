# API y autenticación

Hay cuatro superficies, cada una con su forma de autenticarse. Montos siempre como **string de enteros en
unidades mínimas** (también se aceptan números enteros seguros en la entrada). Respuestas JSON.

| Superficie | Prefijo | Quién la usa | Autenticación |
|---|---|---|---|
| API v1 | `/v1/payment_intents` | Servidor del comercio | `Authorization: Bearer sk_test_…` / `sk_live_…` |
| Checkout | `/v1/checkout/payment_intents` | Navegador del pagador | `Authorization: Bearer pk_…` + `client_secret` del intent |
| Interna | `/internal` | Workers, cron, tesorería, panel administrativo | `X-Internal-Token: <INTERNAL_API_TOKEN>` |
| Dashboard | `/api/dashboard` | Web del comercio | Cookie de sesión `sid` + `X-Requested-With: fetch` — ver [dashboard-api.md](dashboard-api.md) |

## Llaves API (`src/common/api-key.guard.ts`, `src/merchants/merchants.service.ts`)

- Formato `^(sk|pk)_(live|test)_[A-Za-z0-9]{32}$`. Se guarda solo el SHA-256 (`key_hash`) y un prefijo de 12 caracteres para mostrar.
  La secreta en claro se devuelve una sola vez al crearla. La publicable también se guarda en claro (es pública por diseño).
- Cada uso actualiza `last_used_at`. Una llave revocada (`is_active = false`) da 401.
- `sk_` solo vale en la API v1; `pk_` solo en el checkout.
- Llave live contra el sandbox o de prueba contra producción → 401 `wrong_environment`.
- Comercio `restricted` o `closed` → 403 `account_restricted`. Llave live con comercio no `active` → 403 `account_not_activated`.
  Las llaves de prueba funcionan con KYC pendiente.

## API v1 (servidor del comercio)

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/v1/payment_intents` | `{amount, currency, customer?, metadata?, expires_in?}` | `PaymentIntent` (incluye `client_secret`) |
| GET | `/v1/payment_intents/:id` | — | `PaymentIntent` |
| POST | `/v1/payment_intents/:id/attach` | `{payment_method_type, fx_source?}` | `PaymentIntent` |
| POST | `/v1/payment_intents/:id/confirm` | `{payment_method_details?}` | `PaymentIntent` |
| POST | `/v1/payment_intents/:id/cancel` | `{cancellation_reason?}` | `PaymentIntent` |

`currency`: `VES`, `USD`, `EUR`, `USDT`. `expires_in` en segundos (60 a 2.592.000). Un intent de otro comercio responde 404.

```
PaymentIntent = { id, object: 'payment_intent', status, amount, currency, payment_method_type,
  charge: {amount, currency, fee, tax, net, igtf} | null,
  fx: {quote_id, rate, source, expires_at, frozen} | null,
  next_action, last_payment_error, cancellation_reason, metadata, customer,
  client_secret, livemode, expires_at, created, version }
```

## Checkout (navegador)

| Método | Ruta | Cuerpo / query |
|---|---|---|
| GET | `/v1/checkout/payment_intents/:id` | `?client_secret=…` |
| POST | `/v1/checkout/payment_intents/:id/attach` | `{client_secret, payment_method_type}` |
| POST | `/v1/checkout/payment_intents/:id/confirm` | `{client_secret, payment_method_details}` |

El `client_secret` se compara en tiempo constante; si no coincide responde 404 sin revelar nada. La vista del checkout
(`toCheckoutApi`) no incluye `metadata` (salvo `description`), `customer`, comisión ni neto, y no permite cancelar ni elegir `fx_source`.
El GET agrega `merchant: {name, rif}`.

La página `GET /checkout?pi=<id>&cs=<client_secret>&pk=<pk_…>` (`public/checkout.html`) usa esta API.

## API interna (`src/settlements/internal.controller.ts`)

| Método | Ruta | Cuerpo | Qué hace |
|---|---|---|---|
| POST | `/internal/merchants` | `{business_name, rif, webhook_url?}` | Crea comercio (`pending_kyc`) |
| POST | `/internal/merchants/:id/status` | `{status}` | Aprueba o suspende tras KYC |
| POST | `/internal/merchants/:id/api_keys` | `{kind, livemode}` | Crea llave y la devuelve en claro |
| POST | `/internal/merchants/:id/settlement_rules` | `{source_currency, rules: [{target_currency, bps, destination}]}` | Reemplaza la regla de split |
| POST | `/internal/fx/rates` | `{base, quote, rate, source, observed_at?}` | Registra una tasa |
| POST | `/internal/payment_intents/:id/rail_result` | `{source, result: RailResult}` | Aplica el resultado de un riel |
| POST | `/internal/payment_intents/expire` | — | Vence intents abandonados → `{canceled}` |
| POST | `/internal/rail_batches` | `{batch_id, rail, currency, payment_intent_ids}` | Concilia fondos recibidos |
| POST | `/internal/settlement_batches` | `{batch_code, source_currency, min_amount?, spread_bps?}` | Corte de lote |
| POST | `/internal/treasury/contributions` | `{currency, amount, reference}` | Aporte de capital (idempotente por `reference`) |

El token se compara en tiempo constante. Sin `INTERNAL_API_TOKEN` configurado, todo `/internal` responde 401.
La API interna no usa el interceptor de idempotencia: cada operación es idempotente por su propia llave
(asiento, `batch_code`, `reference`).

## Otras rutas

| Ruta | Qué hace |
|---|---|
| `GET /health` | `{ok:true}` si PostgreSQL y Redis responden; si no, 503 `unhealthy` |
| `GET /` | Sitio, docs y dashboard (`public/site.html`) |
| `GET /api/public/methods` | Métodos y precios |
| `GET /pay/:slug` | Crea un intent desde un link de pago y redirige (303) al checkout. Límite: 30 por minuto por IP (429 `too_many_requests`) |

## Idempotencia

`IdempotencyInterceptor` (`src/common/idempotency.interceptor.ts`) en la API v1 y el checkout. Todo POST exige
`Idempotency-Key` (máx. 255 caracteres; si falta, 400 `idempotency_key_required`). Llave en Redis
`idem:<comercio>:<llave>` con huella SHA-256 de método, URL y cuerpo:

| Caso | Respuesta |
|---|---|
| Misma llave y cuerpo, terminada | Repite la respuesta guardada con `Idempotent-Replayed: true` (24 h) |
| Misma llave, aún en curso | 409 `request_in_progress` (el lock dura 60 s) |
| Misma llave, cuerpo distinto | 422 `idempotency_key_reused` |
| Error 4xx (salvo 409) | Se guarda: es determinista |
| Error 5xx o 409 | Se libera la llave para permitir reintento |

Si Redis pierde la llave, la BD sigue impidiendo el doble cobro (ver [payment-intents.md](payment-intents.md#garantías-contra-doble-cobro)).

## Errores

Forma: `{ "error": { "type", "code", "message", ...extra } }` (`ApiExceptionFilter`). `type`:
`invalid_request_error`, `payment_error`, `idempotency_error`, `api_error`. Los 5xx se registran en el log con su stack.

| HTTP | Códigos |
|---|---|
| 400 | `amount_invalid`, `amount_too_small`, `currency_invalid`, `expires_invalid`, `payment_method_invalid`, `idempotency_key_required`, `reference_required`, `settlement_rules_invalid`, `status_invalid`, `kind_invalid`, `kyc_invalid`, `signup_invalid`, `business_name_invalid`, `description_invalid`, `events_invalid`, `url_invalid`, `invalid_request` |
| 401 | `unauthenticated`, `wrong_environment`, `invalid_credentials` |
| 403 | `account_restricted`, `account_not_activated`, `csrf_rejected` |
| 404 | `resource_missing` |
| 409 | `payment_intent_unexpected_state`, `payment_intent_expired`, `fx_quote_expired`, `rail_reference_already_used`, `insufficient_balance`, `request_in_progress`, `payment_not_captured`, `batch_mismatch`, `funds_already_received`, `payout_already_exists`, `key_revoked` |
| 422 | `idempotency_key_reused` |
| 429 | `too_many_attempts`, `too_many_requests` |
| 500 | `internal_error`, `rail_unavailable` |
| 503 | `fx_rate_unavailable`, `unhealthy` |

Al agregar un código nuevo, agrégalo a esta tabla y a la documentación pública de la web (`#/docs` en `public/assets/site.js`).
