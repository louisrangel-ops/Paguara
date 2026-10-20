# API y autenticación

Hay cuatro superficies, cada una con su forma de autenticarse. Montos siempre como **string de enteros en
unidades mínimas** (también se aceptan números enteros seguros en la entrada). Respuestas JSON.

| Superficie | Prefijo | Quién la usa | Autenticación |
|---|---|---|---|
| API v1 | `/v1/payment_intents` | Servidor del comercio | `Authorization: Bearer sk_test_…` / `sk_live_…` |
| Checkout | `/v1/checkout/payment_intents` | Navegador del pagador | `Authorization: Bearer pk_…` + `client_secret` del intent |
| Interna | `/internal` (solo en `INTERNAL_PORT`) | Workers y cron (token de sistema) y personas del panel interno (token de operador) | `X-Internal-Token: <INTERNAL_API_TOKEN>` o `X-Internal-Token: opk_…` |
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
| POST | `/v1/payment_intents` | `{amount, currency, customer?, metadata?, expires_in?, payment_method_types?, return_url?}` | `PaymentIntent` (incluye `client_secret`) |
| GET | `/v1/payment_intents/:id` | — | `PaymentIntent` |
| POST | `/v1/payment_intents/:id/attach` | `{payment_method_type, fx_source?}` | `PaymentIntent` |
| POST | `/v1/payment_intents/:id/confirm` | `{payment_method_details?}` | `PaymentIntent` |
| POST | `/v1/payment_intents/:id/cancel` | `{cancellation_reason?}` | `PaymentIntent` |
| GET | `/v1/account/capabilities` | — | `{object:'list', data: Capability[]}` |
| POST | `/v1/account/capabilities/:key` | `{enabled}` | `Capability` (actor `api_key`) |

`/v1/account/capabilities` no usa el interceptor de idempotencia (encender o apagar es idempotente por sí mismo).
`Capability` está descrito en [dashboard-api.md](dashboard-api.md#métodos-de-pago-y-módulos).

`currency`: `VES`, `USD`, `EUR`, `USDT`. `expires_in` en segundos (60 a 2.592.000). Un intent de otro comercio responde 404.
`return_url` (opcional, `parseReturnUrl` en `src/payment-intents/payment-intents.service.ts`): a dónde vuelve el pagador desde el checkout.
URL absoluta `https://` (también `http://` con llaves de prueba, para tiendas locales), sin usuario ni clave, de hasta 2048
caracteres; si no, 400 `return_url_invalid`. No cambia con una `Idempotency-Key` repetida. Uso: [integraciones](integraciones/README.md).

```
PaymentIntent = { id, object: 'payment_intent', status, amount, currency, payment_method_type, payment_method_types,
  charge: {amount, currency, fee, tax, net, igtf} | null,
  fx: {quote_id, rate, source, expires_at, frozen} | null,
  next_action, last_payment_error, cancellation_reason, metadata, customer, return_url,
  client_secret, livemode, expires_at, created, version }
```

## Checkout (navegador)

| Método | Ruta | Cuerpo / query |
|---|---|---|
| GET | `/v1/checkout/payment_intents/:id` | `?client_secret=…` |
| POST | `/v1/checkout/payment_intents/:id/attach` | `{client_secret, payment_method_type}` |
| POST | `/v1/checkout/payment_intents/:id/confirm` | `{client_secret, payment_method_details}` |

El `client_secret` se compara en tiempo constante; si no coincide responde 404 sin revelar nada. La vista del checkout
(`toCheckoutApi`) no incluye `metadata` (salvo `description`), `customer`, comisión ni neto, y no permite cancelar ni elegir `fx_source`. Sí incluye `return_url`.
El GET agrega `merchant: {name, rif}` y `payment_methods`: los métodos que el pagador puede elegir en ese pago
(activos en el comercio y dentro de `payment_method_types`), cada uno con `{type, name, currency, fee_bps, fixed_usd, tax_bps, igtf_bps, quote_ttl_seconds}`.

La página `GET /checkout?pi=<id>&cs=<client_secret>&pk=<pk_…>` (`public/checkout.html`) usa esta API. Si el pago trae
`return_url`, la página muestra “Volver a la tienda sin pagar” mientras no se paga y, al confirmarse el pago, un botón
para volver que se activa solo a los 5 s. Agrega a la URL `payment_intent=<id>` y `redirect_status=succeeded|canceled`;
la tienda no debe confiar en ese estado y tiene que consultar el pago con su llave secreta.

## API interna (`src/settlements/internal.controller.ts`)

Quién puede: **S** token de sistema (workers, cron), **O** cualquier operador, **M** solo el maestro.

| Método | Ruta | Cuerpo | Quién | Qué hace |
|---|---|---|---|---|
| GET | `/internal/whoami` | — | S, O | `{kind:'system'}` o `{kind:'operator', id, name, role, permissions[]}` |
| POST | `/internal/operators` | `{name, role}` | M (S solo el primer maestro) | Crea una persona; roles: master, compliance, operations, treasury, support, auditor, operator |
| GET | `/internal/operators` | — | `operators:read` | Operadores, rol, estado e historial de cambios |
| POST | `/internal/operators/:id/role` | `{role}` | `operators:manage` | Reasigna el rol; no permite eliminar el último master |
| POST | `/internal/operators/:id/revoke` | — | `operators:manage` | Revoca el token del operador |
| POST | `/internal/operators/:id/revoke` | — | M | Revoca el token (no a sí mismo) |
| GET | `/internal/merchants` | `?q=&status=&limit=` | `merchants:read` | Directorio de comercios por nombre, RIF o id |
| POST | `/internal/merchants` | `{business_name, rif, webhook_url?}` | `merchants:manage` | Crea comercio (`pending_kyc`) |
| GET | `/internal/merchants/:id` | — | S, O, M | KYC completo + perfil ISO 8583 para revisión |
| POST | `/internal/merchants/:id/iso8583_profile` | `{status?, mcc, acquirer_merchant_id, terminal_id, acquiring_institution_id, currency_numeric?, pos_entry_mode?, pos_condition_code?}` | M | Provisiona identificadores técnicos del adquirente |
| POST | `/internal/merchants/:id/status` | `{status}` | M | Aprueba o suspende tras KYC |
| POST | `/internal/merchants/:id/api_keys` | `{kind, livemode}` | M | Crea llave y la devuelve en claro |
| POST | `/internal/merchants/:id/settlement_rules` | `{source_currency, rules: [{target_currency: 'VES', bps: 10000, destination}]}` | M | Cuenta en bolívares para esa moneda cobrada |
| POST | `/internal/fx/rates` | `{base, quote, rate, source, observed_at?}` | S, O | Registra una tasa |
| POST | `/internal/payment_intents/:id/rail_result` | `{source, result: RailResult}` | S, O | Aplica el resultado de un riel |
| POST | `/internal/payment_intents/expire` | — | S, O | Vence intents abandonados → `{canceled}` |
| POST | `/internal/rail_batches` | `{batch_id, rail, currency, payment_intent_ids}` | S, O | Concilia fondos recibidos |
| POST | `/internal/settlement_batches` | `{batch_code, source_currency, min_amount?, spread_bps?}` | S, O | Corte de lote: liquidaciones en VES retenidas |
| GET | `/internal/payouts/pending` | — | O | Liquidaciones esperando aprobación |
| POST | `/internal/payouts/:id/approve` | — | O | Una aprobación; con las pedidas, se libera para pagar |
| GET | `/internal/capabilities` | — | O | Catálogo con `merchants_active` y `pending` por capacidad |
| POST | `/internal/capabilities/:key` | `{global_enabled?, default_for_new?}` | M | Interruptor global (`default_for_new` solo en módulos) |
| GET | `/internal/capability_requests` | — | O | Solicitudes en `pending_review`, las más viejas primero |
| GET | `/internal/merchants/:id/capabilities` | — | O | Capacidades de un comercio |
| POST | `/internal/merchants/:id/capabilities/:key` | `{platform_status?, contract_ref?, fee_bps?, fee_fixed_usd?, min_amount?, max_amount?}` | M | Habilitar (un método exige `contract_ref`), bloquear o negociar (`null` vuelve al valor de plataforma) |
| POST | `/internal/treasury/contributions` | `{currency, amount, reference}` | M | Aporte de capital (idempotente por `reference`) |

El token de sistema se compara en tiempo constante; el de operador se busca por su SHA-256. Token desconocido o revocado: 401. Fuera de rol: 403 `insufficient_role`.
La auditoría usa el nombre del operador que trae el token; el campo `actor` del cuerpo ya no se usa.
La API interna no usa el interceptor de idempotencia: cada operación es idempotente por su propia llave
(asiento, `batch_code`, `reference`).

## Otras rutas

| Ruta | Qué hace |
|---|---|
| `GET /admin` | Panel interno de operaciones (`public/admin.html`) |
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
| 400 | `amount_invalid`, `amount_too_small`, `amount_out_of_range`, `payment_method_not_allowed`, `payment_method_types_invalid`, `no_payment_methods_available` (al crear), `enabled_invalid`, `platform_status_invalid`, `capability_invalid`, `currency_invalid`, `expires_invalid`, `payment_method_invalid`, `idempotency_key_required`, `reference_required`, `settlement_rules_invalid`, `status_invalid`, `kind_invalid`, `kyc_invalid`, `signup_invalid`, `business_name_invalid`, `description_invalid`, `events_invalid`, `url_invalid`, `invalid_request`, `settlement_currency_invalid`, `contract_required`, `contract_ref_invalid`, `name_invalid`, `role_invalid`, `return_url_invalid` |
| 401 | `unauthenticated`, `wrong_environment`, `invalid_credentials` |
| 403 | `account_restricted`, `account_not_activated`, `csrf_rejected`, `payment_method_disabled`, `feature_disabled`, `insufficient_role` |
| 404 | `resource_missing`, `not_found` (rutas internas en el puerto público) |
| 409 | `payment_intent_unexpected_state`, `payment_intent_expired`, `fx_quote_expired`, `rail_reference_already_used`, `insufficient_balance`, `request_in_progress`, `payment_not_captured`, `batch_mismatch`, `funds_already_received`, `payout_already_exists`, `key_revoked`, `capability_locked`, `capability_not_requestable`, `no_payment_methods_available` (en `/pay/:slug`), `payout_already_approved`, `already_approved_by_you`, `payout_not_approved`, `name_taken`, `cannot_revoke_self` |
| 422 | `idempotency_key_reused` |
| 429 | `too_many_attempts`, `too_many_requests`, `rate_limited` (tipo `rate_limit_error`, con `Retry-After`) |
| 500 | `internal_error`, `rail_unavailable` |
| 503 | `fx_rate_unavailable`, `unhealthy` |

Al agregar un código nuevo, agrégalo a esta tabla y a la documentación pública de la web (`#/docs` en `public/assets/site.js`).
