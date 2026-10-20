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
| `INTERNAL_API_TOKEN` | — | Token de **sistema** de `/internal` (`X-Internal-Token`) para workers y cron: tasas, resultados de rieles, conciliación y cortes. No aprueba liquidaciones ni toca comercios; solo crea al primer maestro. Las personas entran con su token `opk_…` y el código de su app (sesión `ops_…`). En despliegues públicos debe tener ≥ 32 caracteres y no ser el de ejemplo | `internal.controller.ts`, `secrets-check.ts` |
| `INTERNAL_PORT` | vacío | Puerto privado donde se sirven `/internal` y `/admin`; en `PORT` dan 404. **Obligatorio con `LIVEMODE=true`** y distinto de `PORT` | `src/main.ts`, `hardening.ts` |
| `KMS_PROVIDER` | `local` | Gestor de llaves: `aws` (AWS KMS) o `local` (llave en `SECRETS_ENCRYPTION_KEY`). **`aws` obligatorio con `LIVEMODE=true`**. Ver [gestor-de-secretos.md](gestor-de-secretos.md) | `src/secrets/kms.ts`, `secrets-check.ts` |
| `KMS_KEY_ID` | — | Con `KMS_PROVIDER=aws`: ARN, id o alias de la llave maestra. La API necesita `kms:GenerateDataKey` y `kms:Decrypt` sobre ella | `kms.ts` |
| `AWS_REGION` (y credenciales estándar de AWS) | — | Región y credenciales del cliente de AWS KMS (rol del servicio o `AWS_*`) | `@aws-sdk/client-kms` |
| `SECRETS_ENCRYPTION_KEY` | vacío | 64 caracteres hex (`openssl rand -hex 32`). Llave maestra **local**: cifra por sobre los secretos de la base (webhooks, doble factor, bancos). **Obligatoria desplegada con `KMS_PROVIDER=local`**; con `aws` es opcional y solo lee lo cifrado antes de migrar. Sin ella (solo local) los secretos se guardan en claro y no se aceptan secretos de bancos | `src/secrets/vault.ts`, `secrets-check.ts` |
| `SECRETS_ENCRYPTION_PREVIOUS_KEYS` | vacío | Llaves locales anteriores (64 hex, separadas por coma): solo descifran, para rotar con `npm run secrets:rewrap` | `kms.ts`, `vault.ts` |
| `OPERATOR_SESSION_HOURS` | `8` | Horas que dura la sesión del panel interno tras el doble factor (máximo 24) | `operators.service.ts` |
| `ALERT_WEBHOOK_URL` | vacío | URL que recibe las alertas como `{text, alert}` (Slack, Teams, Discord, Google Chat). Sin ella solo quedan en `/admin` y en el log | `src/alerts/alerts.service.ts` |
| `RECON_LOOKBACK_DAYS` | `7` | Días hacia atrás en que un cobro o un movimiento todavía puede cruzarse | `reconciliation.service.ts` |
| `RECON_GRACE_DAYS` | `0` | Días de espera antes de reportar un cobro sin dinero en el banco | `reconciliation.service.ts` |
| `PAYOUT_APPROVALS_REQUIRED` | `2` | Personas distintas que aprueban cada liquidación antes de pagarla. Con `LIVEMODE=true`, 2 o más | `settlements.service.ts`, `secrets-check.ts` |
| `RATE_LIMIT_API_PER_MIN` | `600` | Peticiones por minuto por llave en `/v1` | `hardening.ts` |
| `RATE_LIMIT_API_IP_PER_MIN` | `3000` | Tope por IP en `/v1`, además del de la llave (el límite corre antes de validar la llave) | `hardening.ts` |
| `RATE_LIMIT_CHECKOUT_PER_MIN` | `120` | Por IP en `/v1/checkout` | `hardening.ts` |
| `RATE_LIMIT_DASHBOARD_PER_MIN` | `300` | Por IP en `/api` (panel y público) | `hardening.ts` |
| `LIVEMODE` | `false` | `true` = producción (solo llaves live). Cada modo con su propia base | `api-key.guard.ts` |
| `COOKIE_SECURE` | seguro salvo `false` | `false` quita `Secure` a la cookie de sesión (solo http local). Distinto de `false` activa el chequeo de secretos del arranque | `auth.service.ts`, `secrets-check.ts` |
| `TRUST_PROXY` | vacío | Valor de `trust proxy` de Express detrás de un balanceador (p. ej. `1`) | `src/main.ts` |
| `SECURITY_CONTACT` | — | Contacto para reportar vulnerabilidades (`mailto:…` o `https://…`). Sin ella `/.well-known/security.txt` responde 404 | `security-txt.controller.ts` |
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
| `RECON_EVERY_SECONDS` | `3600` | Cada cuánto concilia ayer y hoy contra el banco simulado del sandbox |

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
| `KMS_PROVIDER` / `KMS_KEY_ID` | `local` / vacío | Producción: `aws` y la llave de AWS KMS |
| `SECRETS_ENCRYPTION_KEY` | vacío (en claro) | Sandbox: `openssl rand -hex 32`, en el gestor de secretos del hosting. Producción: no hace falta con AWS |
| `ALERT_WEBHOOK_URL` | vacío | El webhook del canal de operaciones |
| `INTERNAL_PORT` | vacío (mismo puerto) | Un puerto solo de la red privada (obligatorio en producción) |
| `PAYOUT_APPROVALS_REQUIRED` | `1` | `2` o más |

Al agregar una variable: documentarla aquí, agregarla a `.env.example` (y a `.env.development` si aplica) y al [CHANGELOG](CHANGELOG.md).

## `reconcile` (cron diario)

`node dist/scripts/reconcile.js [AAAA-MM-DD]` usa `APP_URL` (el puerto interno) e `INTERNAL_API_TOKEN`. Ver
[conciliacion.md](conciliacion.md#job-diario).
