# Arquitectura y módulos

## Procesos

| Proceso | Qué es | Arranque |
|---|---|---|
| API (`app`) | Aplicación NestJS sobre Express. Sirve la API v1, el checkout, el sitio/dashboard, la API interna y `/health`. Dentro corre también el worker de webhooks. | `node dist/src/main.js` (la imagen migra antes: `node dist/scripts/migrate.js`) |
| `dev-jobs` | Solo desarrollo. Carga tasas FIJAS y vence pagos abandonados llamando a la API interna. Se niega a correr con `LIVEMODE=true`. | `node dist/scripts/dev-jobs.js` (`scripts/dev-jobs.ts`) |
| `seed` | Solo desarrollo. Crea un usuario del panel, su comercio y un par de llaves de prueba. | `node dist/scripts/seed.js` (`scripts/seed.ts`) |
| PostgreSQL 16 | Fuente de verdad: ledger, pagos, comercios, webhooks. | — |
| Redis 7 | Idempotencia de la API v1, límites de intentos de login y de links de pago. | — |

Sandbox y producción son **despliegues separados**, cada uno con su base (`LIVEMODE=false|true`). Una llave de
un ambiente es rechazada en el otro (`src/common/api-key.guard.ts`).

## Arranque (`src/main.ts`)

1. `deployedConfigProblems(process.env)` (`src/common/secrets-check.ts`): si la configuración es insegura para un
   despliegue público, el proceso termina con código 1. Ver [seguridad](seguridad.md).
2. Crea la app con `AppModule`, sirve `public/assets/` en `/assets/` (caché 1 h).
3. Si hay `TRUST_PROXY`, lo pasa a Express (`trust proxy`) para obtener la IP real.
4. Registra `ApiExceptionFilter` como filtro global y escucha en `PORT` (3000 por defecto).

## Módulo único (`src/app.module.ts`)

Todo vive en un solo `AppModule`. Proveedores de infraestructura:

- `PG_POOL`: `pg.Pool` (`src/database/database.ts`), máx. `PG_POOL_MAX` conexiones (20). Los `bigint` de PostgreSQL llegan como `BigInt` de JS.
- `REDIS`: cliente `ioredis` con `REDIS_URL`.
- `RAIL_ADAPTERS`: `Map<riel, RailAdapter>`; hoy **todos los rieles usan `SandboxRail`**, también con `LIVEMODE=true`.

| Carpeta | Piezas | Responsabilidad |
|---|---|---|
| `src/common/` | `money.ts`, `errors.ts`, `api-exception.filter.ts`, `api-key.guard.ts`, `idempotency.interceptor.ts`, `secrets-check.ts`, `hardening.ts`, `secret-box.ts` | Dinero exacto, formato de errores, autenticación por llave, idempotencia, chequeo de arranque, cabeceras, puerto interno, límite de peticiones, cifrado de secretos |
| `src/database/` | `database.ts` | Pool y `withTransaction` (reintenta ante `40001`/`40P01`) |
| `src/ledger/` | `ledger.service.ts`, `chart-of-accounts.ts`, `entry-templates.ts`, `ledger.types.ts` | [Ledger](ledger.md) |
| `src/fx/` | `fx.service.ts`, `fx.math.ts` | [Tasas y cotizaciones](fx.md) |
| `src/payment-intents/` | controlador, servicio, repositorio, máquina de estados, `payment-methods.ts`, `pricing.ts`, `rails/` | [PaymentIntents](payment-intents.md) y [métodos de pago](metodos-de-pago.md) |
| `src/merchants/` | `merchants.service.ts` | Comercios, KYC, llaves API, reglas de liquidación |
| `src/capabilities/` | `capabilities.service.ts`, `capability-state.ts` | [Métodos y módulos por comercio](modulos-por-comercio.md): estado efectivo, precios negociados, auditoría |
| `src/settlements/` | `settlements.service.ts`, `internal.controller.ts` | [Liquidaciones](liquidaciones.md) y la API interna |
| `src/webhooks/` | `webhooks.service.ts` | [Webhooks](webhooks.md): outbox y worker de entrega |
| `src/dashboard/` | `auth.service.ts`, `dashboard.controller.ts`, `dashboard.service.ts` | Sesiones, panel del comercio, links de pago, sitio |
| `src/` | `health.controller.ts`, `checkout-page.controller.ts`, `admin-page.controller.ts` | `/health`, la página de checkout y el panel interno `/admin` |

## Controladores y rutas

| Controlador | Prefijo | Autenticación |
|---|---|---|
| `PaymentIntentsController` | `/v1/payment_intents` | `SecretKeyGuard` (`sk_`) + `IdempotencyInterceptor` |
| `CheckoutController` | `/v1/checkout/payment_intents` | `PublishableKeyGuard` (`pk_`) + `client_secret` + `IdempotencyInterceptor` |
| `AccountCapabilitiesController` | `/v1/account/capabilities` | `SecretKeyGuard` (`sk_`), sin interceptor de idempotencia |
| `InternalController` | `/internal` (solo en `INTERNAL_PORT`) | `InternalTokenGuard` (`X-Internal-Token`: token de sistema o de operador `opk_…`, con rol `master`/`operator` por ruta) |
| `DashboardAuthController` | `/api/dashboard` (signup, login, logout) | Ninguna; exige `X-Requested-With: fetch` |
| `DashboardController` | `/api/dashboard` | `SessionGuard` (cookie `sid`) |
| `PublicController` | `/api/public/methods`, `/pay/:slug` | Ninguna |
| `SitePageController` | `/` | Ninguna (HTML del sitio, `X-Frame-Options: DENY`) |
| `CheckoutPageController` | `/checkout` | Ninguna (HTML; `Referrer-Policy: no-referrer`, `Cache-Control: no-store`) |
| `AdminPageController` | `/admin` | Ninguna para el HTML (no trae datos); cada llamada que hace exige `X-Internal-Token` |
| `HealthController` | `/health` | Ninguna; 200 solo si PostgreSQL y Redis responden |

Detalle de cada ruta en [api.md](api.md) y [dashboard-api.md](dashboard-api.md).

## Flujo de un cobro

```
Servidor del comercio ──POST /v1/payment_intents──▶ API ──▶ payments.payment_intents (requires_payment_method)
Navegador (checkout)  ──attach──▶ cotiza y congela la tasa (fx.quotes), calcula comisión/IVA/IGTF/neto
                      ──confirm─▶ persiste processing ─▶ llama al riel FUERA de la transacción
Riel / worker         ──resultado──▶ succeeded: asiento de captura + transición en la MISMA transacción
                                     + evento en webhooks.events (outbox) en la misma transacción
Tesorería (interno)   ──rail_batches──▶ fondos recibidos: pending → available
                      ──settlement_batches──▶ corte: split por comercio, payout_instructions, settled
Worker de webhooks    ──▶ entrega firmada a los endpoints del comercio con reintentos
```

## Principios transversales

- **Nada de `float` con dinero.** Montos `bigint` en unidades mínimas, tasas `numeric(30,12)` y aritmética entera con redondeo bancario (`src/common/money.ts`).
- **Montos en la API como string de enteros** para no perder precisión en JavaScript.
- **Defensa en profundidad:** las reglas críticas (cuadre de asientos, transiciones, congelamiento de tasa, inmutabilidad) están en la app y se repiten en triggers/`CHECK` de PostgreSQL.
- **Transacciones cortas:** nunca se llama a un riel o a un webhook con locks abiertos.
- **Lock de fila** (`SELECT … FOR UPDATE`) en cada transición de un PaymentIntent.

## Estructura del repositorio

```
db/migrations/        SQL 001–009, aplicado en orden por scripts/migrate.ts
src/                  aplicación NestJS (ver tabla de módulos)
scripts/              migrate.ts, dev-jobs.ts, seed.ts
public/               checkout.html, site.html, admin.html, assets/ (site.css, site.js, site-demo.js)
test/unit/            pruebas puras (dinero, plantillas de asientos, máquina de estados, chequeo de secretos)
test/integration/     pruebas contra PostgreSQL real (crean y borran una BD temporal)
docs/                 esta documentación
.github/workflows/    CI
```

## Frontend

- `public/checkout.html`: checkout alojado tipo Stripe Checkout. Habla solo con `/v1/checkout/...`. Sin parámetros corre en modo demostración.
- `public/site.html` + `public/assets/`: una sola página con rutas por hash (`#/`, `#/docs`, `#/entrar`, `#/registro`, `#/dashboard/...`). El servidor inyecta `window.__SERVER__ = true`; fuera del servidor corre en modo demo (`site-demo.js`).
- `public/admin.html`: panel interno de operaciones (liquidaciones por aprobar, solicitudes con contrato, interruptores globales, ficha de comercio, operadores). Cada persona entra con su token `opk_…`, que queda en `sessionStorage`; las secciones del maestro se ocultan a los operadores. Solo se sirve en `INTERNAL_PORT`.
- La marca es la constante `BRAND` en `public/assets/site.js` y en el script de `checkout.html`. Diseño en [`DESIGN.md`](../DESIGN.md); superficies, movimiento y verificación visual en [web.md](web.md).
