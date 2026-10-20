# API del dashboard (contrato web ↔ servidor)

Prefijo `/api/dashboard`. Sesión por cookie `sid` (HttpOnly, SameSite=Lax). Todo pedido que no sea GET
debe llevar la cabecera `X-Requested-With: fetch` (protección CSRF: un sitio ajeno no puede enviar
cabeceras propias sin CORS). JSON en ambos sentidos. Montos siempre como **string de enteros en
unidades mínimas** (VES/USD 2 decimales, USDT 6). Fechas ISO 8601.

Errores: `{ "error": { "code": "...", "message": "texto en español para mostrar" } }` con status HTTP.
401 `unauthenticated` → la web manda a `#/entrar`.

## Cuenta y sesión
| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | /signup | `{name, email, password, business_name, rif, accept_terms: true}` | 201 `Session`; sin `accept_terms: true` → 400 `signup_invalid` (`param: accept_terms`) |
| POST | /login | `{email, password}` | `Session`; 401 `invalid_credentials`; 429 `too_many_attempts` |
| POST | /logout | — | `{ok:true}` |
| GET | /me | — | `Session` |
| PUT | /account | `{business_name}` | `Merchant` |
| POST | /account/kyc | `{legal_name, representative_name, representative_id, address, phone, bank_name, bank_account}` | `Merchant` |

```
Session  = { user: {id, name, email, role: 'owner'|'admin'|'developer'|'viewer'}, merchant: Merchant, livemode: bool, other_mode_url: string|null,
             event_types: string[] }
Merchant = { id, business_name, rif, status: 'pending_kyc'|'active'|'restricted'|'closed',
             kyc_submitted_at: string|null, created }
```
`password` mínimo 10 caracteres. `rif` formato `J-12345678-9`.

## Inicio
GET /overview →
```
{ balances: Balance[],
  today: { count: number, volume: [{currency, amount}] },
  series: [{ date: 'YYYY-MM-DD', currency, amount, count }],   // últimos 14 días, cobros exitosos por moneda del cobro
  recent: PaymentSummary[],                                   // últimos 6
  needs_action: number }                                      // pagos esperando transferencia del pagador
Balance = { currency, pending, available }   // pending: cobrado, el riel aún no nos pagó; available: listo para liquidar
```

## Pagos
- GET /payments?status=all|succeeded|pending|canceled&q=texto&limit=25&starting_after=pi_x → `{data: PaymentSummary[], has_more}`
  - succeeded = succeeded + settled; pending = requires_* + processing. `q` busca por id o descripción.
- GET /payments/:id → `PaymentDetail`
- POST /payments `{amount, currency, description, expires_in?}` → `{payment: PaymentDetail, checkout_url}`
- POST /payments/:id/cancel → `PaymentDetail`

```
PaymentSummary = { id, status, amount, currency, description|null, payment_method_type|null,
                   charge: {amount, currency, fee, tax, net, igtf}|null, customer|null, created, succeeded_at|null }
PaymentDetail  = PaymentSummary + { fx: {rate, source, expires_at, frozen}|null, next_action|null,
                   last_payment_error|null, metadata, expires_at, cancellation_reason|null, checkout_url|null,
                   timeline: [{from|null, to, event, actor, created}], payout: {id, batch_code, created}|null }
```
`status`: requires_payment_method, requires_confirmation, requires_action, processing, succeeded, settled, canceled.

## Saldos y liquidaciones
- GET /balances → `{ balances: Balance[], payouts: Payout[] }`
```
Payout = { id, batch_code, source_currency, source_amount, created,
           instructions: [{currency, amount, fx_rate|null, fx_spread_bps, destination, status}] }
```
- GET /settlement_rules → `{ rules: { VES: Rule[], USD: Rule[], USDT: Rule[] } }`
- PUT /settlement_rules/:source `{ rules: Rule[] }` (bps suman 10000) → igual que GET
```
Rule = { target_currency, bps, destination: {type:'bank_ves'|'usdt_trc20'|'bank_usd', ...campos} }
```

## Métodos de pago y módulos
Interruptores por comercio (ver [modulos-por-comercio.md](modulos-por-comercio.md)).
- GET /capabilities → `{data: Capability[]}` (métodos en el orden del catálogo, luego módulos)
- PUT /capabilities/:key `{enabled: bool}` → `Capability`; 409 `capability_locked` si la plataforma no lo permite;
  403 `insufficient_role` si el usuario no es `owner` ni `admin`
- POST /capabilities/:key/request → `Capability` en `pending_review`; 409 `capability_not_requestable`
```
Capability = { object:'capability', key, kind:'method'|'module', name,
               state: 'active'|'disabled'|'not_granted'|'pending_review'|'blocked'|'unavailable',
               can_toggle, can_request,
               // solo métodos:
               currency, fee_bps, fixed_usd, tax_bps, igtf_bps, custom_pricing, min_amount|null, max_amount|null }
```

## Links de pago
- GET /payment_links → `{data: Link[]}`
- POST /payment_links `{amount, currency, description, payment_method_types?}` → `Link`;
  403 `feature_disabled` si el módulo `payment_links` está apagado; 400 `payment_method_not_allowed`
- POST /payment_links/:id/deactivate · /activate → `Link` (activar también exige el módulo encendido)
```
Link = { id, url, amount, currency, description, active, payment_method_types: string[]|null, created,
         payments_count, succeeded_count }
```
Abrir `url` (`/pay/<slug>`) crea un pago nuevo y redirige al checkout. Si el link tiene lista de métodos, el pago
acepta los de la lista que sigan activos; si ninguno lo está, responde 409 `no_payment_methods_available`.

## Desarrolladores
- GET /api_keys → `{data: [{id, kind:'secret'|'publishable', livemode, prefix, key|null, active, last_used_at, created, revoked_at}]}`
  (`key` solo para publicables; la secreta se ve una única vez al crearla)
- POST /api_keys `{kind}` → `{id, key}` · POST /api_keys/:id/roll → `{id, key}` · POST /api_keys/:id/revoke → `{ok}`
- GET /webhooks → `{data: Endpoint[]}`
- POST /webhooks `{url, enabled_events}` → `Endpoint & {secret}`
- POST /webhooks/:id/reveal → `{secret}` · /disable · /enable → `Endpoint` · POST /webhooks/:id/test → `{event_id}`
- GET /events?limit&starting_after → `{data: Event[], has_more}` · GET /events/:id → `Event & {payload}` · POST /events/:id/resend → `{ok}`
```
Endpoint = { id, url, enabled_events: string[], status: 'enabled'|'disabled', created,
             last_delivery: {status, at, status_code|null}|null }
Event    = { id, type, created, object_id, deliveries: [{endpoint_id, url, status: 'pending'|'succeeded'|'failed',
             attempts, last_status_code|null, next_attempt_at|null}] }
```
Tipos: payment_intent.created, payment_intent.requires_action, payment_intent.succeeded,
payment_intent.payment_failed, payment_intent.canceled, payment_intent.settled, payout.created.

Firma de webhooks: cabecera `Webhook-Signature: t=<unix>,v1=<hex>` con
`v1 = HMAC_SHA256(secret, "<t>.<cuerpo crudo>")`. Reintentos con espera exponencial hasta 8 intentos.

## Público (sin sesión)
- GET /api/public/methods → `[{type, name, currency, fee_bps, fixed_usd, tax_bps, igtf_bps}]`
- GET /pay/:slug → 303 al checkout
