# Configuración

Todo se configura con variables de entorno. Plantillas: `.env.example` (base para entornos públicos, sin valores
reales) y `.env.development` (sandbox local, ficticio, versionado a propósito). Ningún otro `.env` se versiona.

## API

| Variable | Por defecto | Uso | Dónde se lee |
|---|---|---|---|
| `DATABASE_URL` | — (obligatoria) | Conexión a PostgreSQL | `src/database/database.ts` |
| `PG_POOL_MAX` | `20` | Máximo de conexiones del pool | `src/database/database.ts` |
| `REDIS_URL` | `redis://localhost:6379` | Idempotencia y límites de intentos | `src/app.module.ts` |
| `PORT` | `3000` | Puerto HTTP | `src/main.ts` |
| `INTERNAL_API_TOKEN` | — | Token de **sistema** de `/internal` (`X-Internal-Token`) para workers y cron: tasas, resultados de rieles, conciliación y cortes. No aprueba liquidaciones ni toca comercios; solo crea al primer maestro. Las personas usan su token `opk_…`. En despliegues públicos debe tener ≥ 32 caracteres y no ser el de ejemplo | `internal.controller.ts`, `secrets-check.ts` |
| `INTERNAL_PORT` | vacío | Puerto privado donde se sirven `/internal` y `/admin`; en `PORT` dan 404. **Obligatorio con `LIVEMODE=true`** y distinto de `PORT` | `src/main.ts`, `hardening.ts` |
| `SECRETS_ENCRYPTION_KEY` | vacío | 64 caracteres hex (`openssl rand -hex 32`). Cifra con AES-256-GCM los `whsec_` en la base. **Obligatoria desplegada**; sin ella (solo local) se guardan en claro | `secret-box.ts`, `secrets-check.ts` |
| `PAYOUT_APPROVALS_REQUIRED` | `2` | Personas distintas que aprueban cada liquidación antes de pagarla. Con `LIVEMODE=true`, 2 o más | `settlements.service.ts`, `secrets-check.ts` |
| `RATE_LIMIT_API_PER_MIN` | `600` | Peticiones por minuto por llave en `/v1` | `hardening.ts` |
| `RATE_LIMIT_CHECKOUT_PER_MIN` | `120` | Por IP en `/v1/checkout` | `hardening.ts` |
| `RATE_LIMIT_DASHBOARD_PER_MIN` | `300` | Por IP en `/api` (panel y público) | `hardening.ts` |
| `LIVEMODE` | `false` | `true` = producción (solo llaves live). Cada modo con su propia base | `api-key.guard.ts` |
| `COOKIE_SECURE` | seguro salvo `false` | `false` quita `Secure` a la cookie de sesión (solo http local). Distinto de `false` activa el chequeo de secretos del arranque | `auth.service.ts`, `secrets-check.ts` |
| `TRUST_PROXY` | vacío | Valor de `trust proxy` de Express detrás de un balanceador (p. ej. `1`) | `src/main.ts` |
| `PUBLIC_BASE_URL` | URL del pedido | URL pública para links de pago y checkout | `dashboard.controller.ts` |
| `OTHER_MODE_DASHBOARD_URL` | `null` | Dashboard del otro modo, para el selector "modo de prueba" | `dashboard.controller.ts` |
| `FX_MAX_RATE_AGE_SECONDS` | `21600` (6 h) | Antigüedad máxima de una tasa para cotizar | `fx.service.ts` |
| `FX_PAYOUT_SPREAD_BPS` | `120` (1,2 %) | Spread al convertir liquidaciones | `settlements.service.ts` |
| `WEBHOOK_ALLOW_HTTP` | `false` | `true` permite endpoints `http://` (desarrollo) | `webhooks.service.ts` |
| `WEBHOOK_ALLOW_PRIVATE` | `false` | `true` permite `localhost` e IPs privadas (desarrollo) | `webhooks.service.ts` |
| `WEBHOOK_WORKER` | activo | `false` apaga el worker de entrega en esa réplica | `webhooks.service.ts` |
| `WEBHOOK_POLL_MS` | `2000` | Frecuencia del worker de webhooks | `webhooks.service.ts` |

Las variables `FX_*`, `LIVEMODE` y `FX_PAYOUT_SPREAD_BPS` se leen al cargar el módulo: cambiarlas exige reiniciar.

## `dev-jobs` (solo desarrollo)

| Variable | Por defecto | Uso |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | URL de la API |
| `INTERNAL_API_TOKEN` | — (obligatoria) | El mismo de la API |
| `DEV_FX_RATES` | `USD/VES:BCV:36.5,USDT/VES:BINANCE_P2P:37.2,USD/USDT:EXCHANGE:1.0005` | Tasas fijas `par:fuente:tasa` |
| `FX_REFRESH_SECONDS` | `3600` | Cada cuánto recarga las tasas |
| `EXPIRE_EVERY_SECONDS` | `60` | Cada cuánto vence intents abandonados |

Termina con error si `LIVEMODE=true`.

## `seed` (solo desarrollo)

| Variable | Por defecto | Uso |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | URL de la API |
| `INTERNAL_API_TOKEN` | — (obligatoria) | Para crear el primer maestro del panel interno (las llaves se crean con la sesión del panel) |
| `SEED_EMAIL` | `dev@paguara.test` | Usuario del panel |
| `SEED_PASSWORD` | `paguara-dev-123` | Clave; **obligatoria** si `COOKIE_SECURE` no es `false` |

Termina con error si `LIVEMODE=true`.

## Valores por entorno

| Variable | Local (`.env.development`) | Entorno público |
|---|---|---|
| `INTERNAL_API_TOKEN` | `dev-internal-token` | `openssl rand -hex 32` |
| `COOKIE_SECURE` | `false` | `true` |
| `WEBHOOK_ALLOW_HTTP` / `WEBHOOK_ALLOW_PRIVATE` | `true` / `true` | `false` / `false` |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | El dominio público |
| `TRUST_PROXY` | vacío | `1` detrás del balanceador |
| `SECRETS_ENCRYPTION_KEY` | vacío (en claro) | `openssl rand -hex 32`, en el gestor de secretos |
| `INTERNAL_PORT` | vacío (mismo puerto) | Un puerto solo de la red privada (obligatorio en producción) |
| `PAYOUT_APPROVALS_REQUIRED` | `1` | `2` o más |

Al agregar una variable: documentarla aquí, agregarla a `.env.example` (y a `.env.development` si aplica) y al [CHANGELOG](CHANGELOG.md).
