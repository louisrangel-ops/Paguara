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
| `dev:jobs`, `seed` | Procesos de desarrollo con `tsx` (`dev-jobs` también concilia contra el banco simulado) |
| `reconcile` | Conciliación diaria de todos los rieles (cron); en la imagen `node dist/scripts/reconcile.js` |
| `secrets:rewrap` | Vuelve a cifrar los secretos con la llave activa tras rotarla o pasar a AWS KMS ([gestor-de-secretos.md](gestor-de-secretos.md#rotación)) |
| `typecheck` | `tsc --noEmit` |
| `test` | Pruebas unitarias (`test/unit/*.test.ts`, `node:test` vía `tsx`) |
| `test:integration` | Pruebas contra PostgreSQL real, una a la vez; necesitan `DATABASE_URL` a un servidor (crean y borran una BD temporal) |

## Railway (entorno de desarrollo público)

Pasos en el [README](../README.md#desplegar-el-entorno-de-desarrollo-en-railway); **no probados todavía**. Resumen:
servicio desde el `Dockerfile` con healthcheck `/health`; PostgreSQL y Redis del proyecto; variables de
`.env.development` cambiando `INTERNAL_API_TOKEN`, `PUBLIC_BASE_URL`, `COOKIE_SECURE=true`, `WEBHOOK_ALLOW_PRIVATE=false`
y `TRUST_PROXY=1`; segundo servicio con `node dist/scripts/dev-jobs.js`; seed una vez con `SEED_PASSWORD` propio.

## Vercel (web en modo demostración)

Vercel publica solo la web estática, sin API: el sitio, la documentación y el panel corren con los datos de
ejemplo de `public/assets/site-demo.js`, y el checkout simula el pago. Sirve para mostrar el diseño; no cobra ni
guarda nada. La API, PostgreSQL y Redis siguen yendo en Railway u otro hosting de contenedores.

- `vercel.json` le dice a Vercel que no instale dependencias, que corra `node scripts/build-web.mjs` y que publique
  `dist-web/`. Activa `cleanUrls` y cabeceras de seguridad (`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`;
  `no-referrer` en `/checkout`).
- `scripts/build-web.mjs` envuelve `site.html` y `checkout.html` igual que los controladores de Nest pero **sin**
  `window.__SERVER__`, copia `public/assets/` y apunta `DEMO_CHECKOUT_URL` a `/checkout` del mismo despliegue.
  No incluye `/admin`, que necesita la API.
- Rutas publicadas: `/` (sitio con rutas en el hash: `#/precios`, `#/docs`, `#/entrar`, `#/dashboard`) y `/checkout`.
- Para crearlo: en vercel.com, **Add New → Project**, importar `louisrangel-ops/Paguara` y **Deploy** sin cambiar
  nada (la configuración sale de `vercel.json`). Cada push a `main` vuelve a publicar y cada PR recibe su vista previa.
- Probarlo local: `node scripts/build-web.mjs` y servir `dist-web/` con cualquier servidor estático.

## Sandbox para integraciones de comercios

Los comercios integran su web contra una instancia aparte con `LIVEMODE` distinto de `true`, su propia base y
llaves `sk_test_`/`pk_test_`. Allí todos los rieles son `SandboxRail` (no mueven dinero) y cada comercio nuevo recibe
todos los métodos sin contrato (ver [modulos-por-comercio.md](modulos-por-comercio.md#entorno-de-pruebas-sandbox)).
Las llaves de prueba no sirven en producción ni las live en el sandbox (401 `wrong_environment`).

## Producción

**Pendiente** (rieles reales, job de tasas). Lo que el código ya impone con `LIVEMODE=true`:

- No arranca si queda algún riel de prueba (`buildRails` en `src/app.module.ts`).
- `COOKIE_SECURE` distinto de `false`, `INTERNAL_API_TOKEN` propio de ≥ 32 caracteres, `KMS_PROVIDER=aws` con
  `KMS_KEY_ID` (la llave local no se acepta), `INTERNAL_PORT` distinto de `PORT` y `PAYOUT_APPROVALS_REQUIRED` ≥ 2.
- `dev-jobs` y `seed` se niegan a correr.

`INTERNAL_PORT` sirve `/internal` y `/admin` y debe quedar solo en la red privada (VPN o red interna del hosting),
nunca expuesto al público; en el puerto público esas rutas dan 404. El primer maestro se crea una sola vez con el
token de sistema (`POST /internal/operators {name, role: 'master'}` por el puerto interno); su token `opk_…` se
muestra una vez y desde ahí el maestro crea a los demás desde `/admin`. En desarrollo lo hace `npm run seed`
(maestro `maestro-dev`; también al repetirlo sobre una base que ya tenía el comercio de prueba, si aún no hay maestro).
Al entrar por primera vez a `/admin` cada persona activa su app autenticadora ([doble-factor.md](doble-factor.md)).

Además, en producción:

- **AWS KMS**: crear una llave simétrica con rotación automática, dar al rol del servicio solo `kms:GenerateDataKey`
  y `kms:Decrypt` sobre ella, y definir `KMS_PROVIDER=aws`, `KMS_KEY_ID` y `AWS_REGION`. Si la base ya tenía secretos
  con la llave local, correr `secrets:rewrap` una vez ([gestor-de-secretos.md](gestor-de-secretos.md)).
- **Cron diario de conciliación** a las 06:00 de Caracas (10:00 UTC): `node dist/scripts/reconcile.js` con `APP_URL`
  apuntando al puerto interno. Subir los extractos de los bancos sin API antes de esa hora ([conciliacion.md](conciliacion.md)).
- **`ALERT_WEBHOOK_URL`** del canal de operaciones.

## CI (`.github/workflows/ci.yml`)

En cada PR y en cada push a `main`:

| Job | Pasos |
|---|---|
| `test` | Servicios `postgres:16` y `redis:7`; `npm ci`, `npm run typecheck`, `npm test`, `npm run test:integration` y `docker build` |
| `secrets` | `gitleaks` v8.21.2 sobre todo el historial (`fetch-depth: 0`) con `.gitleaks.toml` |
| `woocommerce` | PHP del runner (8.3): `php -l` de cada archivo del plugin y `php tests/run.php` ([integraciones/woocommerce.md](integraciones/woocommerce.md#pruebas)) |

`.github/workflows/iso8583-tests.yml` (job `simulator`): en PRs que tocan `src/payment-intents/rails/iso8583/**`,
`test/unit/iso8583-*.test.ts` o el propio workflow, y en push a `feature/iso8583-acquirer-foundation`, corre
`npm ci`, `npm run typecheck` y `npm test` (sin servicios).

## Pruebas existentes

| Archivo | Cubre |
|---|---|
| `test/unit/money.test.ts` | Conversión, redondeo bancario, reparto por bps |
| `test/unit/entry-templates.test.ts` | Asientos de captura, fondos y liquidación cuadrados |
| `test/unit/state-machine.test.ts` | Transiciones permitidas y prohibidas |
| `test/unit/secrets-check.test.ts` | Chequeo de configuración del arranque |
| `test/unit/iso8583-codec.test.ts` | Ida y vuelta del perfil de prueba ISO 8583 y rechazo de campos y mensajes inválidos |
| `test/unit/iso8583-simulator.test.ts` | Simulador emisor: autorización idempotente, rechazo, timeout, reversos, conflictos de STAN/RRN, perfil propio |
| `test/unit/hardening.test.ts` | Arranque live sin rieles de prueba, rutas internas, reglas de límite de peticiones |
| `test/unit/kms.test.ts` | Cifrado por sobre local y AWS (cliente falso), propósito atado al dato, rotación, formatos anteriores |
| `test/unit/totp.test.ts` | Vectores del RFC 6238, desfase de reloj, códigos de respaldo, parser de extractos, fecha de Caracas |
| `test/integration/iso8583-e2e.test.ts` | Flujo completo con `Iso8583SimulatorRail`: aprobación, rechazo del emisor y timeout después de aprobar |
| `test/integration/ledger.test.ts` | Triggers del ledger, idempotencia de asientos, 100 asientos concurrentes sin deadlock |
| `test/integration/payment-intent-flow.test.ts` | Tabla SQL = tabla TS, flujo completo, P2P, rechazos, cotización vencida, confirmaciones simultáneas, USDT, IGTF, aislamiento entre comercios |
| `test/integration/merchants-checkout.test.ts` | Llaves, KYC, RIF, checkout con `client_secret`, idempotencia durable, vencimiento, saldos no editables, corte de lote, `return_url` |
| `test/integration/capabilities.test.ts` | Defaults y solicitudes, métodos apagados, lista por pago, bloqueo global, precios y límites negociados, módulos de links/webhooks, métodos por contrato y sandbox, panel interno, Banesco Panamá en sandbox |
| `test/integration/payout-approvals.test.ts` | Operadores y roles, doble aprobación de liquidaciones, triggers de la BD, instrucciones solo en VES |
| `test/unit/return-url.test.ts` | Validación de `return_url` |
| `test/integration/dashboard.test.ts` | scrypt, registro y sesiones, límite de login, outbox y entrega de webhooks, SSRF, listados |
| `test/integration/security.test.ts` | 2FA del comercio (inscripción, repetición, respaldo, login en dos pasos, bloqueo, reinicio), sesiones de operador con 2FA, secretos de bancos cifrados y versionados, rewrap |
| `test/integration/reconciliation.test.ts` | Cruce por referencia y monto, liberación de fondos, diferencias y su cierre, alertas sin repetir, extracto faltante, job diario con el banco simulado |
