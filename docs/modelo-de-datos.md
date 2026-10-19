# Modelo de datos y migraciones

PostgreSQL 16. Las migraciones están en `db/migrations/NNN_nombre.sql` y las aplica `scripts/migrate.ts`
en orden alfabético, cada una en su propia transacción y una sola vez (tabla `public.schema_migrations`).
Un `pg_advisory_lock(726354)` evita que dos réplicas migren a la vez.

**Regla:** una migración ya fusionada no se edita; todo cambio de esquema es una migración nueva con el
siguiente número, documentada aquí y en el [CHANGELOG](CHANGELOG.md).

## Esquemas

| Esquema | Para qué | Migración |
|---|---|---|
| `ledger` | Monedas, cuentas, asientos, partidas, saldos | 001, 004 |
| `fx` | Tasas observadas y cotizaciones congeladas | 002 |
| `payments` | PaymentIntents, transiciones, links de pago | 003, 005, 007, 008 |
| `merchants` | Comercios, llaves API, reglas de liquidación, capacidades por comercio | 005, 007, 008 |
| `settlements` | Lotes, liquidaciones e instrucciones de pago | 006 |
| `dashboard` | Usuarios del panel y sesiones | 007 |
| `webhooks` | Endpoints, eventos (outbox) y entregas | 007 |
| `platform` | Catálogo de métodos y módulos con su interruptor global | 008, 009 |

## Migraciones

### 001 · `001_ledger.sql` — Ledger de doble partida multi-moneda
- `ledger.currencies (code, exponent, kind)` con VES (2), USD (2), EUR (2), USDT (6).
- `ledger.account_type` ENUM: `asset`, `liability`, `equity`, `revenue`, `expense`.
- `ledger.accounts`: `code` único y legible (`merchant:acct_x:pending:VES`), tipo, moneda, dueño (`platform`/`merchant`), `allow_negative`.
- `ledger.journal_entries`: `idempotency_key` única, `kind`, referencia, `reverses_entry_id` (un reverso por asiento), `metadata`.
- `ledger.postings`: `amount bigint <> 0` (débito `+`, crédito `−`), `fx_rate` informativo.
- `ledger.account_balances`: saldo materializado por cuenta.
- Triggers: fila de saldo al crear cuenta; código/tipo/moneda de cuenta inmutables (`P0001`); moneda de partida = moneda de cuenta (`P0002`); saldo del lado contrario a la naturaleza de la cuenta (`P0003`); cuadre por moneda y mínimo 2 partidas, diferido al COMMIT (`P0004`); `postings` y `journal_entries` append-only (`P0005`).
- Vistas de auditoría `ledger.balance_drift` (debe estar vacía) y `ledger.trial_balance` (cada moneda debe sumar 0).

### 002 · `002_fx.sql` — Tasas y cotizaciones
- `fx.rates`: tasa `numeric(30,12) > 0`, fuente en `BCV`, `PARALLEL`, `BINANCE_P2P`, `EXCHANGE`, `MANUAL`; única por (par, fuente, `observed_at`).
- `fx.quotes`: id `fxq_…`, copia congelada de la tasa, `expires_at > created_at`.
- Ambas append-only (UPDATE/DELETE prohibidos).
- Convención: 1 `base_currency` = `rate` `quote_currency` (USD→VES 36,5 = 1 USD vale 36,50 Bs).

### 003 · `003_payment_intents.sql` — PaymentIntents y su máquina de estados
- ENUM `payments.pi_status`: `requires_payment_method`, `requires_confirmation`, `requires_action`, `processing`, `succeeded`, `settled`, `canceled`.
- `payments.allowed_transitions`: espejo de la tabla de la app ([payment-intents.md](payment-intents.md)).
- `payments.payment_intents`: precio (`amount`, `currency`), lo cobrado (`payment_method_type`, `rail`, `charge_currency`, `charge_amount`), tasa congelada (`fx_quote_id`, `fx_rate`, `fx_rate_source`, `fx_quote_expires_at`), desglose (`fee_amount`, `tax_amount`, `net_amount`, `igtf_amount`), `status`, `version`, `next_action`, `last_payment_error`, `rail_reference`, asientos vinculados (`capture_entry_id`, `funds_received_entry_id`, `settlement_entry_id`) y marcas de tiempo.
- `CHECK`: datos de cobro completos desde `requires_confirmation`; `charge_amount = fee + tax + net + igtf`; `succeeded`/`settled` exigen asiento de captura; fondos recibidos solo tras captura; `settled` exige liquidación y fondos.
- Índice único `(rail, rail_reference)`: una referencia bancaria no confirma dos pagos.
- `payments.payment_intent_transitions`: historial append-only (desde, hacia, evento, actor, detalles, asiento).
- Trigger `pi_guard`: id/comercio/monto/moneda inmutables (`P0010`), solo transiciones permitidas (`P0011`), montos y tasa congelados desde `processing` y asientos vinculados no reemplazables (`P0012`); incrementa `version`. `DELETE` prohibido.

### 004 · `004_ledger_hardening.sql` — Saldo corrido y saldos no editables
- `ledger.postings.balance_after` (NOT NULL): saldo de la cuenta tras la partida; el trigger pasa a `BEFORE INSERT` para escribirlo.
- `ledger.account_balances` solo cambia desde el trigger de partidas (`pg_trigger_depth() >= 2`); UPDATE/DELETE directo → `P0005`; TRUNCATE prohibido.
- Nuevo `kind` de asiento: `capital_contribution`.

### 005 · `005_merchants_auth_checkout.sql` — Comercios, llaves y checkout
- `merchants.merchants`: id `^[a-z0-9_]+$` (se usa en códigos de cuenta), `business_name`, `rif` único con formato `[JGVEP]-?########-?#`, `status` (`pending_kyc`, `active`, `restricted`, `closed`), `webhook_url` y `webhook_secret` (columnas de esta versión; el worker de webhooks usa `webhooks.endpoints` de la 007).
- `merchants.api_keys`: `kind` (`secret`/`publishable`), `livemode`, `key_hash` (SHA-256, único), `key_prefix`, `is_active`, `last_used_at`, `revoked_at`.
- `merchants.settlement_rules`: (comercio, moneda origen, moneda destino) → `bps` (1–10000) y `destination` jsonb.
- `payment_intents`: FK a comercio, `livemode`, `idempotency_key` (única por comercio), `client_secret` (único), `customer` jsonb, `expires_at` (24 h por defecto); se agrega `banesco_panama` a los métodos.

### 006 · `006_settlement_batches.sql` — Corte de lote
- `settlements.batches`: id `stb_…`, `batch_code` único, `status` `open`/`closed`.
- `settlements.payouts`: id `po_…`, una por (lote, comercio, moneda origen), con su asiento.
- `settlements.payout_instructions`: lo que ejecuta tesorería (moneda, monto, `fx_rate`, `fx_spread_bps`, `destination`, `status` `pending`/`sent`/`confirmed`/`failed`, `external_ref`).

### 007 · `007_dashboard_webhooks_links.sql` — Dashboard, webhooks y links de pago
- `merchants.merchants`: `kyc_data` jsonb y `kyc_submitted_at`.
- `merchants.api_keys.publishable_key`: la llave publicable en claro (solo para `kind = 'publishable'`).
- `dashboard.users`: id `usr_…`, correo único en minúsculas, `password_hash` scrypt, `role` (`owner`, `admin`, `developer`, `viewer`; hoy solo se crea `owner`).
- `dashboard.sessions`: solo el SHA-256 del token, `expires_at`, `revoked_at`.
- `webhooks.endpoints` (`we_…`, `secret` `whsec_…`, `enabled_events text[]`, `status`), `webhooks.events` (`evt_…`, append-only) y `webhooks.deliveries` (una por evento y endpoint, con intentos y próximo intento).
- `payments.payment_links`: `plink_…`, `slug` 12–40 alfanumérico, monto, moneda, descripción, `livemode`, `active`; `payment_intents.payment_link_id`.
- Índice `(merchant_id, created_at DESC, id DESC)` para los listados del dashboard.

### 008 · `008_capabilities.sql` — Interruptores por comercio (PR #4)
- Esquema `platform`. `platform.capabilities (key, kind 'method'|'module', global_enabled, default_for_new, updated_at)` con los diez métodos y los módulos `payment_links` y `webhooks`.
- `merchants.capabilities (merchant_id, key, platform_status 'allowed'|'pending_review'|'blocked', merchant_enabled, fee_bps, fee_fixed_usd, min_amount, max_amount, updated_by, updated_at)`; `CHECK` de rangos y `min_amount ≤ max_amount`.
- `merchants.capability_changes`: auditoría append-only (`merchant_id NULL` = cambio global).
- Función `merchants.capability_state(merchant, key)` → `unavailable`, `not_granted`, `blocked`, `pending_review`, `disabled` o `active`. Es la única regla.
- Trigger en `merchants.merchants`: cada comercio nuevo recibe las capacidades `default_for_new`. A los comercios existentes se les dieron todas.
- `payment_intents.payment_method_types` y `payment_links.payment_method_types` (`text[]`, `NULL` = todos los activos).

### 009 · `009_settlement_modules_admin.sql` — Módulos de liquidación en divisas (PR #6)
- Módulos `settlement_usdt` y `settlement_usd`, otorgados a todos los comercios existentes.
- Índice `capabilities_pending_idx` para la bandeja de solicitudes del panel interno.

Detalle funcional en [modulos-por-comercio.md](modulos-por-comercio.md).

## Prefijos de identificadores

| Prefijo | Objeto | Generado en |
|---|---|---|
| `pi_` | PaymentIntent (`pi_<id>_secret_…` es su `client_secret`) | `payment-intents.service.ts` |
| `fxq_` | Cotización congelada | `fx.service.ts` |
| `acct_` | Comercio | `merchants.service.ts`, `auth.service.ts` |
| `key_` | Llave API (`sk_test_`/`sk_live_`/`pk_test_`/`pk_live_` + 32 hex) | `merchants.service.ts` |
| `usr_` | Usuario del panel | `auth.service.ts` |
| `stb_`, `po_` | Lote y liquidación | `settlements.service.ts` |
| `we_`, `whsec_`, `evt_` | Endpoint, secreto y evento de webhook | `webhooks.service.ts` |
| `plink_` | Link de pago | `dashboard.service.ts` |

## Códigos de error de la base de datos

| Código | Origen | Cómo sale por la API (`api-exception.filter.ts`) |
|---|---|---|
| `P0001` | Cambio de código/tipo/moneda de cuenta | 500 `internal_error` |
| `P0002` | Partida en moneda distinta a la cuenta | 500 `internal_error` |
| `P0003` | Saldo insuficiente / del lado contrario | 409 `insufficient_balance` |
| `P0004` | Asiento descuadrado o con < 2 partidas | 500 `internal_error` |
| `P0005` | Modificar algo append-only o un saldo a mano | 500 `internal_error` |
| `P0010` | Cambiar id/comercio/monto/moneda de un intent | 500 `internal_error` |
| `P0011`, `P0012` | Transición no permitida / montos congelados | 409 `payment_intent_unexpected_state` |
| `23505` en `payment_intents_rail_ref_idx` | Referencia bancaria reutilizada | 409 `rail_reference_already_used` |
