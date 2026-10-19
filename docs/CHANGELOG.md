# CHANGELOG técnico

Cambios técnicos de Paguara por PR: código, esquema, API, configuración y despliegue. Lo más reciente arriba.
Cada PR que cambie algo de eso agrega su entrada en **Sin publicar** (ver [CONTRIBUTING](../CONTRIBUTING.md)).

Formato de cada entrada: `- [Área] Qué cambió, en una línea (#PR)`. Áreas: API, Esquema, Ledger, FX, Rieles,
Liquidaciones, Webhooks, Dashboard, Web, Config, Despliegue, CI, Seguridad, Docs.
Cada migración nueva se anota con su número.

## Sin publicar

- [Docs] Documentación de los PRs #4 y #6 en arquitectura, modelo de datos (migraciones 008 y 009), PaymentIntents, métodos de pago, API, webhooks, liquidaciones, seguridad y pruebas; `modulos-por-comercio.md` en el índice (#7).
- [Docs] Documentación técnica en `docs/` (arquitectura, datos, ledger, PaymentIntents, FX, métodos de pago, API, webhooks, liquidaciones, configuración, despliegue, seguridad) y este CHANGELOG (#5).
- [Docs] `CONTRIBUTING.md` y plantilla de PR: todo cambio de código, esquema, API o configuración actualiza la documentación y el CHANGELOG en el mismo PR (#5).
- [Docs] README: corrige cómo se rota el secreto de un webhook (no existe ruta para borrar endpoints) y aclara que `Idempotency-Key` se exige en la API v1 y el checkout, no en `/internal` (#5).

## 2026-10-19

### #6 · Interruptores por comercio: liquidaciones en divisas, panel interno y checkout completo
- [Esquema] Migración 009: módulos `settlement_usdt` y `settlement_usd` (otorgados a los comercios existentes) e índice de solicitudes pendientes.
- [Liquidaciones] Guardar una regla que convierte a USDT o USD exige su módulo (403 `feature_disabled`); el corte salta al comercio con `settlement_module_disabled` y sus pagos esperan al próximo corte.
- [API] `GET /internal/capabilities` (con conteos) y `GET /internal/capability_requests` (bandeja).
- [Web] Panel interno en `/admin` (`public/admin.html`, `AdminPageController`): solicitudes, interruptores globales y ficha de comercio, con el token interno en `sessionStorage`.
- [Web] El checkout pinta los diez métodos, incluidos formularios de débito inmediato y tarjeta nacional, y la transferencia de Banesco Panamá.
- [Rieles] `SandboxRail`: `banesco_panama` responde `requires_action` con `bank_transfer`.

### #4 · Interruptores por comercio: métodos de pago y módulos
- [Esquema] Migración 008: `platform.capabilities`, `merchants.capabilities`, `merchants.capability_changes`, función `merchants.capability_state` y `payment_method_types` en pagos y links.
- [API] `payment_method_types` al crear pagos y links; validación en `attach`/`confirm` (`payment_method_not_allowed`, `payment_method_disabled`, `amount_out_of_range`, `no_payment_methods_available`); precios y límites negociados por comercio.
- [API] `GET/POST /v1/account/capabilities`, `POST /internal/capabilities/:key`, `GET/POST /internal/merchants/:id/capabilities[/:key]`; el checkout devuelve `payment_methods`.
- [Dashboard] `GET /capabilities`, `PUT /capabilities/:key`, `POST /capabilities/:key/request`, solo para `owner`/`admin` (`insufficient_role`); la sesión expone el rol.
- [Webhooks] Evento `account.capability.updated`; con el módulo `webhooks` apagado no se programan ni entregan envíos.
- [Docs] `docs/modulos-por-comercio.md`.

### #3 · Seguridad de secretos
- [Seguridad] La API no arranca en despliegues públicos (`LIVEMODE=true` o `COOKIE_SECURE` ≠ `false`) con `INTERNAL_API_TOKEN` de ejemplo o de menos de 32 caracteres, ni con `LIVEMODE=true` y `COOKIE_SECURE=false` (`src/common/secrets-check.ts`, llamado desde `main.ts`; pruebas en `test/unit/secrets-check.test.ts`).
- [Seguridad] `seed` exige `SEED_PASSWORD` fuera de local.
- [Config] `.gitignore` y `.dockerignore` excluyen todo `.env*` salvo las plantillas, llaves y volcados; `.env.example` documenta cómo generar el token.
- [CI] Job `secrets` con gitleaks v8.21.2 sobre todo el historial; `.gitleaks.toml` y hook opcional en `.pre-commit-config.yaml`.
- [Despliegue] `docker-compose.yml` publica PostgreSQL y Redis solo en `127.0.0.1`.

### #2 · Entorno de desarrollo desplegable
- [Despliegue] `Dockerfile` multi-etapa (migra y arranca), `docker-compose.yml` con `postgres`, `redis`, `app`, `dev-jobs` y `seed`, `.env.development` versionado sin secretos.
- [API] `GET /health`: 200 si PostgreSQL y Redis responden, 503 `unhealthy` si no.
- [Config] `scripts/dev-jobs.ts`: tasas fijas (`DEV_FX_RATES`) y vencimiento de intents vía la API interna; no corre con `LIVEMODE=true`.
- [Config] `scripts/seed.ts`: usuario del panel, comercio y llaves de prueba.
- [CI] `.github/workflows/ci.yml`: typecheck, pruebas unitarias e integración contra PostgreSQL y Redis, y `docker build`.
- [Despliegue] Pasos para Railway en el README (sin probar).

### #1 · Sistema de diseño
- [Web] `DESIGN.md` con colores, tipografía, alturas de controles y reglas citadas de `site.css`.

## 2026-10-16

### Commit 3c20e4b · Web de Paguara (directo a `main`, sin PR)
- [Web] Sitio público, documentación de la API y panel del comercio en `public/site.html` y `public/assets/` (rutas por hash, modo demo fuera del servidor).

### Commit a4152f6 · Núcleo de la pasarela (directo a `main`, sin PR)
- [Esquema] Migraciones 001 (ledger), 002 (FX), 003 (PaymentIntents), 004 (saldo corrido y saldos no editables), 005 (comercios, llaves, checkout), 006 (lotes de liquidación) y 007 (dashboard, webhooks, links de pago).
- [Ledger] Doble partida multi-moneda append-only con plan de cuentas bajo demanda.
- [API] API v1 de PaymentIntents con llaves `sk_`, checkout con `pk_` + `client_secret`, API interna con token, idempotencia con Redis.
- [FX] Cotizaciones congeladas con vencimiento por riel; aritmética exacta.
- [Rieles] Diez métodos de pago sobre `SandboxRail`.
- [Liquidaciones] Conciliación de fondos, corte de lote con split por comercio y spread 1,2 %.
- [Webhooks] Outbox transaccional con entrega firmada y reintentos.
- [Dashboard] Registro, sesiones, pagos, saldos, links de pago, llaves y webhooks (`docs/dashboard-api.md`); checkout alojado.
