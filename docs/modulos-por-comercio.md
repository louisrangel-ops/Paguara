# Métodos de pago y módulos por comercio

Cada comercio decide qué métodos de pago ofrece y qué módulos del producto usa, dentro de lo que la plataforma
le permite. Introducido en la migración `008_capabilities.sql`. La `010_ves_payouts_operators.sql` hizo que los
métodos se habiliten solo por contrato y retiró los módulos de liquidación en divisas (a los comercios se les paga
solo en bolívares, ver [liquidaciones.md](liquidaciones.md)).

## Dos capas

1. **Plataforma (Paguara)**: decide qué existe y a quién se le habilita.
   - `platform.capabilities.global_enabled`: interruptor de emergencia para todos (riel caído, banco sin convenio).
   - `platform.capabilities.default_for_new`: si cada comercio nuevo lo recibe al registrarse. **Solo módulos**: un
     método nunca se da solo (CHECK `capabilities_methods_by_contract`), porque habilitarlo exige un contrato firmado.
   - **Métodos por contrato**: solo el maestro de Paguara habilita un método a un comercio, y debe indicar la referencia
     del contrato (`contract_ref`, 3 a 120 caracteres; sin ella, 400 `contract_required`). Bloquear o negociar precio
     no la exige.
   - `merchants.capabilities.platform_status`: `allowed`, `pending_review` o `blocked` para un comercio.
   - Precio y límites negociados por comercio: `fee_bps`, `fee_fixed_usd`, `min_amount`, `max_amount`.
2. **Comercio**: enciende o apaga (`merchant_enabled`) lo que la plataforma le permitió.

Capacidades (`key`):

| Tipo | Llaves |
|---|---|
| Método (`method`) | `pago_movil_c2p`, `pago_movil_p2p`, `debito_inmediato`, `card_national`, `card_international`, `zelle`, `banesco_panama`, `usdt_trc20`, `usdt_polygon`, `cash` |
| Módulo (`module`) | `payment_links`, `webhooks` |

`settlement_usdt` y `settlement_usd` siguen en el catálogo con `retired_at` (la auditoría los referencia), apagados y
fuera de todos los listados.

## Entorno de pruebas (sandbox)

Para que los comercios integren su web sin esperar el contrato, en una instancia con `LIVEMODE` distinto de `true`
cada comercio nuevo (registro en la web o `POST /internal/merchants`) recibe todos los métodos habilitados globalmente,
con `updated_by = 'platform:sandbox'` (`grantSandboxMethods` en `src/capabilities/capability-state.ts`). Allí todos
los rieles son de prueba y no mueven dinero. En producción (`LIVEMODE=true`) eso no ocurre: el comercio pide el
método desde su panel y el maestro lo habilita al firmar el contrato.

## Estado efectivo

`merchants.capability_state(merchant_id, key)` (SQL) es la única regla; la usan la API, el checkout, el panel
y el outbox de webhooks.

| Estado | Cuándo | ¿El comercio lo puede cambiar? |
|---|---|---|
| `unavailable` | `global_enabled = false` | No |
| `not_granted` | El comercio no tiene fila para esa capacidad | Puede pedirlo (`pending_review`) |
| `blocked` | `platform_status = 'blocked'` | No |
| `pending_review` | `platform_status = 'pending_review'` | No |
| `disabled` | `merchant_enabled = false` | Sí, lo enciende |
| `active` | Todo lo anterior en verde | Sí, lo apaga |

## Datos

- `platform.capabilities (key, kind, global_enabled, default_for_new, updated_at)`: catálogo.
- `merchants.capabilities (merchant_id, key, platform_status, merchant_enabled, contract_ref, fee_bps, fee_fixed_usd, min_amount, max_amount, updated_by, updated_at)`.
  `contract_ref` es la referencia del contrato con que se habilitó el método (los habilitados antes de la 010 no la tienen).
  `min_amount` y `max_amount` están en unidades mínimas de la moneda de cobro del método (VES para Pago Móvil, USDT para USDT).
- `merchants.capability_changes`: auditoría append-only (quién, cuándo, antes y después). `merchant_id NULL` = cambio global.
- Un trigger en `merchants.merchants` le da a cada comercio nuevo las capacidades `default_for_new` (hoy solo módulos).
- La migración le dio a cada comercio existente todas las capacidades, para que nada cambie al desplegar.
- `payments.payment_intents.payment_method_types` y `payments.payment_links.payment_method_types` (`text[]`, `NULL` = todos los activos).

## Dónde se valida

| Momento | Regla | Error |
|---|---|---|
| Crear el PaymentIntent con `payment_method_types` | Cada método debe estar `active` | 400 `payment_method_not_allowed` |
| Crear el PaymentIntent sin lista | Debe haber al menos un método activo | 400 `no_payment_methods_available` |
| `attach` | El método debe estar en la lista del pago (si la tiene) | 400 `payment_method_not_allowed` |
| `attach` | El método debe estar `active` | 403 `payment_method_disabled` |
| `attach` | El monto en moneda de cobro dentro de `min_amount`/`max_amount` | 400 `amount_out_of_range` |
| `confirm` desde `requires_confirmation` | Se repiten las dos reglas anteriores | igual que `attach` |
| Pagos en `processing` o `requires_action` | No se tocan: apagar un método nunca deja dinero a medio camino | — |
| Links de pago (crear, activar, abrir `/pay/:slug`) | Módulo `payment_links` activo | 403 `feature_disabled` |
| Webhooks (crear endpoint, activar, probar, reenviar) | Módulo `webhooks` activo | 403 `feature_disabled` |
| Outbox de webhooks | Con el módulo apagado el evento se guarda pero no se programan entregas; las pendientes esperan a que se encienda | — |
| Habilitar un método (`platform_status: 'allowed'`) | Debe traer `contract_ref` | 400 `contract_required` |
| `default_for_new = true` en un método | Prohibido (también en la BD) | 400 `contract_required` |

El precio que se cobra en `attach` es el del comercio si tiene uno negociado, si no el de `PAYMENT_METHODS`.

## Quién lo cambia

- **Panel** (`/api/dashboard/capabilities`): solo usuarios con rol `owner` o `admin` (`403 insufficient_role`).
  Página **Métodos de pago** en `#/dashboard/metodos`.
- **API del comercio** (`sk_`): `GET /v1/account/capabilities`, `POST /v1/account/capabilities/:key {enabled}`.
- **Panel interno** en `/admin` (solo en el puerto interno, `INTERNAL_PORT`): bandeja de solicitudes (aprobar con
  la referencia del contrato, o rechazar), interruptores globales con cuántos comercios tienen cada capacidad, y la
  ficha de un comercio para permitir, bloquear o fijar precio y límites. Cada persona entra con su propio token de
  operador (`opk_…` más el código de su app autenticadora; la sesión `ops_…` queda en `sessionStorage` y se borra al cerrar la pestaña); la auditoría guarda
  `platform:<nombre>`. El token de sistema no sirve para el panel. Los operadores ven las bandejas; solo el maestro
  cambia. Rechazar deja la capacidad en `blocked`.
- **Plataforma** (`X-Internal-Token: ops_…`, la sesión del operador; **O** cualquier operador, **M** solo el maestro):
  - O `GET /internal/capabilities`: catálogo con `merchants_active` y `pending` por capacidad
  - O `GET /internal/capability_requests`: solicitudes en `pending_review`, las más viejas primero
  - M `POST /internal/capabilities/:key {global_enabled?, default_for_new?}`
  - O `GET /internal/merchants/:id/capabilities`
  - M `POST /internal/merchants/:id/capabilities/:key {platform_status?, contract_ref?, fee_bps?, fee_fixed_usd?, min_amount?, max_amount?}`
    (`null` vuelve al valor de plataforma)

Cada cambio de un comercio emite el webhook `account.capability.updated` con la capacidad nueva como objeto.

## Checkout

`GET /v1/checkout/payment_intents/:id` devuelve `payment_methods`: los métodos que el pagador puede elegir en ese
pago, con los precios del comercio. `public/checkout.html` solo pinta esos, y ya sabe mostrar los diez:

| Método | Qué pide o muestra |
|---|---|
| `pago_movil_c2p` | Banco, cédula, teléfono y clave C2P |
| `debito_inmediato` | Banco, cédula, teléfono y clave de débito inmediato (SMS o token del banco) |
| `card_national` | Tarjeta (campos del procesador nacional) y cédula del titular |
| `card_international` | Tarjeta (campos del procesador internacional) |
| `pago_movil_p2p`, `zelle` | Datos para transferir (`pago_movil_transfer`, `zelle_transfer`) |
| `banesco_panama` | Cuenta, titular, monto y concepto (`next_action.type = 'bank_transfer'`) |
| `usdt_trc20`, `usdt_polygon` | Red, dirección, monto y QR (`crypto_transfer`, `network` TRON o POLYGON) |
| `cash` | Código para pagar en taquilla (`cash_voucher`) |

En modo demostración, `checkout.html?metodos=zelle,usdt_trc20` simula un comercio con solo esos.

## Ejemplos

Crear un pago que solo acepta Pago Móvil y USDT:

```bash
curl https://api.paguara.test/v1/payment_intents \
  -H "Authorization: Bearer sk_test_..." -H "Idempotency-Key: pedido-1043" \
  -H "Content-Type: application/json" \
  -d '{"amount":"2500","currency":"USD","payment_method_types":["pago_movil_c2p","usdt_trc20"]}'
```

Apagar efectivo para un comercio por riesgo, y habilitarle Zelle por contrato al 1 % sin fijo (token del maestro):

```bash
curl -X POST .../internal/merchants/acct_123/capabilities/cash -H "X-Internal-Token: ops_..." \
  -d '{"platform_status":"blocked"}'
curl -X POST .../internal/merchants/acct_123/capabilities/zelle -H "X-Internal-Token: ops_..." \
  -d '{"platform_status":"allowed","contract_ref":"CTR-2026-0142","fee_bps":100,"fee_fixed_usd":0}'
```

## Decisiones

- **Sin caché en Redis del estado.** Es una consulta por índice en PostgreSQL dentro de la misma transacción que
  cobra. Una caché obligaría a leer dos versiones en Redis (global y del comercio) para invalidar bien, que cuesta lo
  mismo que la consulta, y abriría una ventana en que un método recién bloqueado todavía cobra. Se revisa si
  el checkout llega a ser un cuello de botella medido.

## Pendiente

- Notificar al comercio por correo cuando se aprueba o rechaza su solicitud (hoy solo cambia en el panel y llega el webhook).
