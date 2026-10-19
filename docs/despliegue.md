# Despliegue, pruebas y CI

## Imagen Docker (`Dockerfile`)

Una sola imagen para la API y los procesos auxiliares. Etapa `build` (`node:22-slim`): `npm ci`, `tsc` y
`npm prune --omit=dev`. Etapa final: `node_modules`, `dist`, `db/` y `public/`, usuario `node`, puerto 3000,
`HEALTHCHECK` contra `/health` cada 15 s.

Comando por defecto: `node dist/scripts/migrate.js && node dist/src/main.js` (migra y arranca; el lock consultivo de
`migrate.ts` evita choques si arrancan dos réplicas).

`.dockerignore` excluye `.git`, `.github`, `docs`, `video`, todo `.env*` y archivos de llaves o volcados.

## Entorno local (`docker-compose.yml`)

| Servicio | Imagen / comando | Notas |
|---|---|---|
| `postgres` | `postgres:16` | Base `pasarela`, puerto solo en `127.0.0.1:5432`, volumen `postgres_data` |
| `redis` | `redis:7 --appendonly yes` | Las llaves de idempotencia sobreviven a un reinicio; puerto solo en `127.0.0.1:6379` |
| `app` | build local | `.env.development`, puerto 3000 |
| `dev-jobs` | `node dist/scripts/dev-jobs.js` | Tasas fijas y vencimientos |
| `seed` | `node dist/scripts/seed.js` | Perfil `tools`: `docker compose run --rm seed` |

```bash
docker compose up -d --build     # http://localhost:3000/health → {"ok":true}
docker compose run --rm seed     # dev@paguara.test / paguara-dev-123 y llaves sk_test_/pk_test_
```

Sin Docker para la app: `docker compose up -d postgres redis`, cargar `.env.development`, `npm install`,
`npm run migrate`, `npm run build && npm start`, y en otras terminales `npm run dev:jobs` y `npm run seed`.

## Scripts (`package.json`)

| Script | Qué hace |
|---|---|
| `build` | `tsc` a `dist/` |
| `start` | `node dist/src/main.js` |
| `migrate` / `migrate:dist` | Aplica migraciones (con `tsx` / compilado) |
| `dev:jobs`, `seed` | Procesos de desarrollo con `tsx` |
| `typecheck` | `tsc --noEmit` |
| `test` | Pruebas unitarias (`test/unit/*.test.ts`, `node:test` vía `tsx`) |
| `test:integration` | Pruebas contra PostgreSQL real, una a la vez; necesitan `DATABASE_URL` a un servidor (crean y borran una BD temporal) |

## Railway (entorno de desarrollo público)

Pasos en el [README](../README.md#desplegar-el-entorno-de-desarrollo-en-railway); **no probados todavía**. Resumen:
servicio desde el `Dockerfile` con healthcheck `/health`; PostgreSQL y Redis del proyecto; variables de
`.env.development` cambiando `INTERNAL_API_TOKEN`, `PUBLIC_BASE_URL`, `COOKIE_SECURE=true`, `WEBHOOK_ALLOW_PRIVATE=false`
y `TRUST_PROXY=1`; segundo servicio con `node dist/scripts/dev-jobs.js`; seed una vez con `SEED_PASSWORD` propio.

## Producción

**Pendiente.** Requisitos que el código ya impone: `LIVEMODE=true` con su propia base, `COOKIE_SECURE` distinto de
`false`, `INTERNAL_API_TOKEN` propio de ≥ 32 caracteres, sin `dev-jobs` ni `seed` (se niegan a correr). Antes hace
falta el job real de tasas, rieles reales y el cifrado de secretos de webhooks con KMS.

## CI (`.github/workflows/ci.yml`)

En cada PR y en cada push a `main`:

| Job | Pasos |
|---|---|
| `test` | Servicios `postgres:16` y `redis:7`; `npm ci`, `npm run typecheck`, `npm test`, `npm run test:integration` y `docker build` |
| `secrets` | `gitleaks` v8.21.2 sobre todo el historial (`fetch-depth: 0`) con `.gitleaks.toml` |

## Pruebas existentes

| Archivo | Cubre |
|---|---|
| `test/unit/money.test.ts` | Conversión, redondeo bancario, reparto por bps |
| `test/unit/entry-templates.test.ts` | Asientos de captura, fondos y liquidación cuadrados |
| `test/unit/state-machine.test.ts` | Transiciones permitidas y prohibidas |
| `test/unit/secrets-check.test.ts` | Chequeo de configuración del arranque |
| `test/integration/ledger.test.ts` | Triggers del ledger, idempotencia de asientos, 100 asientos concurrentes sin deadlock |
| `test/integration/payment-intent-flow.test.ts` | Tabla SQL = tabla TS, flujo completo, P2P, rechazos, cotización vencida, confirmaciones simultáneas, USDT, IGTF, aislamiento entre comercios |
| `test/integration/merchants-checkout.test.ts` | Llaves, KYC, RIF, checkout con `client_secret`, idempotencia durable, vencimiento, saldos no editables, corte de lote |
| `test/integration/capabilities.test.ts` | Defaults y solicitudes, métodos apagados, lista por pago, bloqueo global, precios y límites negociados, módulos de links/webhooks/liquidación, panel interno, Banesco Panamá en sandbox |
| `test/integration/dashboard.test.ts` | scrypt, registro y sesiones, límite de login, outbox y entrega de webhooks, SSRF, listados |
