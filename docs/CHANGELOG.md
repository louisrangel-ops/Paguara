# CHANGELOG técnico

Cambios técnicos de Paguara por PR: código, esquema, API, configuración y despliegue. Lo más reciente arriba.
Cada PR que cambie algo de eso agrega su entrada en **Sin publicar** (ver [CONTRIBUTING](../CONTRIBUTING.md)).

Formato de cada entrada: `- [Área] Qué cambió, en una línea (#PR)`. Áreas: API, Esquema, Ledger, FX, Rieles,
Liquidaciones, Webhooks, Dashboard, Web, Config, Despliegue, CI, Seguridad, Docs.
Cada migración nueva se anota con su número.

## Sin publicar

- [Esquema] Migración 013: roles internos funcionales y `platform.operator_role_changes` append-only.
- [Seguridad] RBAC del panel interno con permisos por endpoint y protección contra revocar/demover al último master.
- [API] Directorio de comercios, detalle KYC/ISO 8583, cambio de rol de operadores y `whoami.permissions`.
- [Web] `/admin` ampliado a consola integral: comercios, KYC, ISO 8583, métodos, llaves, liquidaciones y gestión de roles.
- [Tests] Matriz RBAC interna cubierta por pruebas unitarias.
- [Docs] Nueva guía [admin-panel-rbac.md](admin-panel-rbac.md).


- [Web] `#/docs` exige sesión del comercio; se ocultan los enlaces de documentación en landing, navegación, pie y login hasta autenticar.
- [Dashboard] Onboarding KYC ampliado con ubicación, soporte, actividad, URL e-commerce y descriptor; prohíbe usar el formulario para datos de tarjeta.
- [Esquema] Migración 012: `merchants.iso8583_profiles` separa MCC/MID/TID/identificador adquirente y parámetros del perfil.
- [API] `GET /internal/merchants/:id` para revisión y `POST /internal/merchants/:id/iso8583_profile` para provisionamiento técnico por el maestro.
- [Docs] Nueva guía [merchant-onboarding-iso8583.md](merchant-onboarding-iso8583.md).




- [Integraciones] Plugin de WooCommerce en `integraciones/woocommerce/paguara-woocommerce/`: redirección al checkout alojado, regreso a la tienda, webhooks firmados verificados y consulta del pago con la llave secreta, modo pruebas y checkout de bloques. Ver [integraciones/woocommerce.md](integraciones/woocommerce.md).
- [API] `return_url` opcional al crear un PaymentIntent (400 `return_url_invalid`); viene en `PaymentIntent` y en la vista del checkout.
- [Esquema] Migración 012: `payments.payment_intents.return_url`.
- [Web] El checkout vuelve a la tienda: enlace “Volver a la tienda sin pagar” y, al pagar, botón y regreso automático a los 5 s con `payment_intent` y `redirect_status`.
- [CI] Job `woocommerce`: `php -l` y las pruebas del plugin.
- [Docs] Guía de integración con tiendas en línea y orden recomendado de plataformas: [integraciones/README.md](integraciones/README.md).
- [Docs] Documentos legales en borrador como páginas del sitio (`#/legal/...`): términos, acuerdo de comercio, privacidad, cookies, uso aceptable, prevención de LC/FT y divulgación responsable; textos en `public/assets/legal.js`. Ver [legal.md](legal.md).
- [Esquema] Migración 011: `dashboard.legal_acceptances`, append-only, constancia de la versión aceptada con IP y navegador.
- [API] `POST /api/dashboard/signup` exige `accept_terms: true` (400 `signup_invalid`, `param: accept_terms`) y registra la aceptación en la misma transacción.
- [Web] Casilla de aceptación en el registro, enlaces legales en el pie del sitio y del checkout, aviso de cookies informativo (`localStorage` `paguara_cookies`).
- [Seguridad] `GET /.well-known/security.txt` (RFC 9116) si `SECURITY_CONTACT` está definida.
- [Config] `SECURITY_CONTACT`.
- [Rieles] Base ISO 8583 en `src/payment-intents/rails/iso8583/`: codec ASCII de perfil de prueba y simulador emisor en memoria (autorización, rechazo, timeout, reversos, conciliación). No es un riel registrado ni toca `LIVEMODE` (#13).
- [CI] Workflow `iso8583-tests.yml`: typecheck y pruebas unitarias en PRs que tocan el codec o el simulador (#13).
- [Docs] `iso8583-acquirer-integration.md` (requisitos del adquirente y próximos pasos, #13). La documentación de #13 en métodos de pago, CI, pruebas e índice; el riel sandbox ya no se describe como activo en `LIVEMODE=true` y webhooks aclara que el secreto se guarda cifrado cuando hay `SECRETS_ENCRYPTION_KEY` (#11); entradas de #12 con su número (#15).

- [Docs] Documentos legales en borrador como páginas del sitio (`#/legal/...`): términos, acuerdo de comercio, privacidad, cookies, uso aceptable, prevención de LC/FT y divulgación responsable; textos en `public/assets/legal.js`. Ver [legal.md](legal.md) (#12).
- [Esquema] Migración 011: `dashboard.legal_acceptances`, append-only, constancia de la versión aceptada con IP y navegador (#12).
- [API] `POST /api/dashboard/signup` exige `accept_terms: true` (400 `signup_invalid`, `param: accept_terms`) y registra la aceptación en la misma transacción (#12).
- [Web] Casilla de aceptación en el registro, enlaces legales en el pie del sitio y del checkout, aviso de cookies informativo (`localStorage` `paguara_cookies`) (#12).
- [Seguridad] `GET /.well-known/security.txt` (RFC 9116) si `SECURITY_CONTACT` está definida (#12).
- [Config] `SECURITY_CONTACT` (#12).

- [Esquema] Migración 010: liquidación solo en VES (CHECK en reglas e instrucciones), `platform.operators`, `settlements.payouts.status/approvals_required`, `settlements.payout_approvals`, triggers `P0020`, módulos de liquidación en divisas retirados (`retired_at`) y métodos por contrato (`contract_ref`, sin `default_for_new`) (#11).
- [Liquidaciones] Por ley se paga a los comercios solo en bolívares: lo cobrado en USD o USDT se convierte a VES en el corte; reglas con otra moneda o distintas del 100 % → 400 `settlement_currency_invalid`/`settlement_rules_invalid` (#11).
- [Liquidaciones] Las instrucciones nacen `on_hold`; `GET /internal/payouts/pending` y `POST /internal/payouts/:id/approve` las liberan con `PAYOUT_APPROVALS_REQUIRED` personas distintas (2 por defecto) (#11).
- [API] Operadores con token propio `opk_…` (`/internal/operators`, `/internal/whoami`), roles `master`/`operator` por ruta (403 `insufficient_role`); el token de sistema solo sirve a los workers y para crear el primer maestro; se quita `actor` del cuerpo (#11).
- [API] Habilitar un método a un comercio exige `contract_ref` (400 `contract_required`); en el sandbox cada comercio nuevo recibe todos los métodos para integrar (#11).
- [Seguridad] Puerto interno (`INTERNAL_PORT`) para `/internal` y `/admin` (404 en el público), cabeceras CSP/HSTS/nosniff/frame, límite de peticiones en Redis por llave y por IP (429 `rate_limited`), secretos de webhooks cifrados con AES-256-GCM (`SECRETS_ENCRYPTION_KEY`) (#11).
- [Rieles] Con `LIVEMODE=true` la API no arranca si queda un riel de prueba (#11).
- [Config] `SECRETS_ENCRYPTION_KEY`, `INTERNAL_PORT`, `PAYOUT_APPROVALS_REQUIRED`, `RATE_LIMIT_*`; en live se exigen las tres primeras (#11).
- [Web] Panel del comercio con "Cuenta de liquidación" en bolívares; panel interno con login por operador, bandeja de aprobaciones, contrato al habilitar y alta de operadores; docs públicas con la sección de pruebas (#11).
- [Despliegue] `npm run seed` crea el primer maestro (`maestro-dev`) aunque el comercio de prueba ya exista, así una base que se sube a la 010 también lo recibe (#11).
- [Docs] Liquidaciones, ledger, modelo de datos, API, seguridad, configuración, despliegue, arquitectura y módulos por comercio actualizados (#11).

- [Despliegue] `scripts/build-web.mjs` ya no acepta carpeta de salida: siempre escribe en `dist-web/`, así el borrado previo nunca toca el repo (#10).
- [CI] El test de API keys fallaba 1 de cada 16 corridas: la llave "alterada" era idéntica cuando la original ya terminaba en `0` (#10).
- [Despliegue] `vercel.json` y `scripts/build-web.mjs`: la web se publica en Vercel en modo demostración (sitio y checkout, sin API ni `/admin`) en `dist-web/` (#9).
- [Web] Rediseño de todas las superficies con la misma paleta y logo: landing nueva (hero con el recibo sobre un mostrador verde, cinta de rieles, métodos agrupados por moneda, estados reales del pago), panel con transiciones cortas, checkout a dos columnas en pantallas anchas con métodos agrupados por moneda, y panel interno con barra superior, interruptores y contador de solicitudes (#8).
- [Web] Sistema de movimiento sin librerías: clase `.motion` según `prefers-reduced-motion`, revelado con `IntersectionObserver`, contador, cinta CSS, borde de cabecera con `animation-timeline: scroll()` y View Transitions entre páginas públicas; ≈ 2,5 KB comprimidos (#8).
- [Web] Google Fonts pedidas como rango variable (`wght@400..700`, `wght@500..600`); el panel interno carga también Spline Sans Mono (#8).
- [Docs] `docs/web.md` (superficies, proceso de diseño, reglas y presupuesto de movimiento, verificación) y `DESIGN.md` con composición, tokens de movimiento y referencias de línea actualizadas (#8).

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
