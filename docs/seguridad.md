# Seguridad

## Secretos y configuración

- Solo se versionan `.env.example` y `.env.development` (ficticios). `.gitignore` y `.dockerignore` excluyen todo otro `.env*`,
  llaves (`*.pem`, `*.key`, `*.p12`, `*.pfx`) y volcados (`*.rdb`, `*.aof`, `*.dump`, `*.sql.gz`).
- En hosting, los secretos van en las variables del servicio, no en archivos.
- **Chequeo al arrancar** (`src/common/secrets-check.ts`, llamado en `main.ts`): si `LIVEMODE=true` o `COOKIE_SECURE`
  no es `false`, la API no arranca cuando `INTERNAL_API_TOKEN` es un valor de ejemplo (`cambia-esto`, `dev-internal-token`)
  o tiene menos de 32 caracteres, ni cuando se combina `LIVEMODE=true` con `COOKIE_SECURE=false`.
- Desplegada exige además `SECRETS_ENCRYPTION_KEY`. Con `LIVEMODE=true` exige `INTERNAL_PORT` distinto de `PORT` y
  `PAYOUT_APPROVALS_REQUIRED` ≥ 2, y **no arranca mientras algún método use el riel de prueba** (`buildRails` en
  `src/app.module.ts`): el sandbox aprueba cobros sin mover dinero y la liquidación pagaría dinero real.
- `seed` exige `SEED_PASSWORD` propio fuera de local; `seed` y `dev-jobs` no corren con `LIVEMODE=true`.
- **gitleaks** en CI sobre todo el historial y, opcional, en local con `pre-commit install` (`.pre-commit-config.yaml`).
  Excepciones en `.gitleaks.toml` (solo los datos de demo de `public/assets/site-demo.js` y referencias `pedido-N-x`).
- Auditoría del 2026-10-19: sin secretos reales en el historial.

## Rotación

| Secreto | Cómo |
|---|---|
| `INTERNAL_API_TOKEN` | Cambiar la variable y reiniciar la API y `dev-jobs` |
| Token de operador `opk_…` | El maestro revoca a la persona en `/admin` (o `POST /internal/operators/:id/revoke`), lo que cierra sus sesiones `ops_`, y le crea uno nuevo |
| `SECRETS_ENCRYPTION_KEY` / llave del KMS | `npm run secrets:rewrap` vuelve a cifrar todo con la llave activa; pasos en [gestor-de-secretos.md](gestor-de-secretos.md#rotación) |
| Secretos de los bancos | Cargar la versión nueva en `/admin` → *Secretos de los bancos*; la anterior queda retirada |
| Llave `sk_`/`pk_` | *Rotar* en el panel (`POST /api/dashboard/api_keys/:id/roll`): crea una nueva y revoca la anterior |
| `whsec_` de un webhook | Crear un endpoint nuevo y desactivar el anterior |

## Llaves API

SHA-256 en la base; la secreta se muestra una vez. Formato validado antes de consultar. Separación sandbox/producción
por despliegue. Detalle en [api.md](api.md#llaves-api).

## Panel del comercio

- Contraseñas con scrypt (`N=16384, r=8, p=1`, sal de 16 bytes), mínimo 10 caracteres. Si el correo no existe se compara
  contra un hash fijo para que la respuesta tarde lo mismo.
- Sesión: token aleatorio de 32 bytes en cookie `sid` `HttpOnly; SameSite=Lax; Secure` por 14 días; en la base solo su SHA-256.
- CSRF: todo pedido que no sea GET/HEAD exige `X-Requested-With: fetch` (403 `csrf_rejected`).
- Límite de login: 10 fallos por correo o 50 por IP en 15 minutos → 429 `too_many_attempts` (Redis).
- Roles: cambiar métodos y módulos (`PUT /api/dashboard/capabilities/:key` y solicitarlos) exige rol `owner` o `admin` (403 `insufficient_role`). El resto del panel todavía no distingue roles.
- Registro: el comercio nace `pending_kyc` y solo opera con llaves de prueba hasta que cumplimiento lo active. Exige `accept_terms: true` y guarda la constancia (versión, IP, navegador) en `dashboard.legal_acceptances` ([legal.md](legal.md)).
- Divulgación responsable: política en `#/legal/seguridad` y `/.well-known/security.txt` cuando `SECURITY_CONTACT` está definida.

## Checkout y links de pago

- El `client_secret` viaja en la URL del checkout: la página responde con `Referrer-Policy: no-referrer` y `Cache-Control: no-store`.
- El `client_secret` se compara en tiempo constante; si no coincide, 404 sin detalles.
- `/pay/:slug`: 30 visitas por minuto por IP; el slug se valida antes de consultar.
- El sitio se sirve con `X-Frame-Options: DENY`.

## Borde de la API (`src/common/hardening.ts`, aplicado en `main.ts`)

- **Cabeceras** en toda respuesta: `Content-Security-Policy` (scripts propios e inline, más cdnjs para qrcodejs;
  estilos y fuentes de Google Fonts; `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Cross-Origin-Opener-Policy: same-origin` y, salvo con `COOKIE_SECURE=false`, `Strict-Transport-Security` de un año.
  Sin `X-Powered-By`. Las páginas que ya fijaban `no-referrer` lo siguen haciendo.
- **Límite de peticiones** con ventana de un minuto en Redis: `/v1` 600 por llave (la llave se cuenta por su hash,
  no se guarda) y 3000 por IP (el límite corre antes de validar la llave: sin el de IP, una llave inventada distinta en
  cada petición lo esquivaría), `/v1/checkout` 120 por IP, `/api` 300 por IP. Al pasarse: 429 `rate_limited` con `Retry-After` y
  `RateLimit-Limit`/`RateLimit-Remaining`. Si Redis falla se deja pasar y se registra. `/internal` y `/health` no se limitan.
- **Rutas internas fuera de internet**: con `INTERNAL_PORT`, `/internal` y `/admin` responden solo en ese puerto (red
  privada del hosting o VPN); en el público dan 404 como si no existieran.

## Panel interno (`/admin`) y operadores

- Cada persona entra con **su propio token** (`opk_` + 48 hex; en `platform.operators` solo su SHA-256) **más el código
  de su app autenticadora**: el doble factor es obligatorio y abre una sesión `ops_…` de `OPERATOR_SESSION_HOURS` horas.
  El token solo ya no abre `/internal` (401 `operator_session_required`). Ver [doble-factor.md](doble-factor.md#panel-interno-obligatorio).
  El `INTERNAL_API_TOKEN` es de los procesos automáticos: el panel no lo acepta.
- Roles: **maestro** (KYC, habilitar métodos por contrato, precios y límites, interruptores, llaves y cuentas de
  liquidación de un comercio, aportes de tesorería, alta y baja de operadores) y **operador** (ver bandejas y aprobar
  liquidaciones). El token de sistema hace lo de los workers (tasas, resultados de rieles, conciliación, cortes,
  vencimientos) y solo puede crear al primer maestro. Fuera de rol: 403 `insufficient_role`.
- La auditoría (`merchants.capability_changes.actor`) guarda `platform:<nombre del operador>`, que el servidor saca del
  token (ya no lo escribe la persona).
- **Métodos por contrato**: ningún método se le da solo a un comercio nuevo en producción (`CHECK
  capabilities_methods_by_contract`); el maestro lo habilita con `contract_ref` del contrato firmado (400
  `contract_required` sin él), que queda en `merchants.capabilities.contract_ref`.
- **Doble aprobación de liquidaciones**: ver [liquidaciones.md](liquidaciones.md#4-aprobación-antes-de-pagar).
- La página no trae datos; solo la sesión `ops_` queda en `sessionStorage` y se borra al cerrar la pestaña. Se sirve con
  `Cache-Control: no-store`, `X-Frame-Options: DENY` y `Referrer-Policy: no-referrer`.

## Webhooks

Firma HMAC-SHA256 y protección SSRF por IP efectiva de conexión: [webhooks.md](webhooks.md#protección-ssrf).
Los secretos `whsec_` se guardan cifrados por sobre con el KMS (`env:v1:…`, `src/secrets/vault.ts`): un respaldo
robado de la base no sirve para firmar webhooks. Los guardados antes en `enc:v1:` o en claro se siguen leyendo y
`npm run secrets:rewrap` los pasa al formato nuevo. Ver [gestor-de-secretos.md](gestor-de-secretos.md).

## Doble factor, secretos de los bancos y conciliación

- **Doble factor** (TOTP y códigos de respaldo): obligatorio en `/admin`, opcional en el panel del comercio y exigido
  al cambiar la cuenta de liquidación si está activo. Ver [doble-factor.md](doble-factor.md).
- **Llaves y certificados de los bancos** en `platform.rail_credentials`, cifrados por sobre con el KMS; la base rechaza
  un valor en claro. Ver [gestor-de-secretos.md](gestor-de-secretos.md#secretos-de-los-bancos-srcsecretsrail-credentialsservicets).
- **Conciliación diaria** banco ↔ ledger con alertas a `ALERT_WEBHOOK_URL`. Ver [conciliacion.md](conciliacion.md).

## Base de datos

Las reglas de dinero se imponen también con triggers y `CHECK` ([modelo-de-datos.md](modelo-de-datos.md)): un bug de la
app o un `UPDATE` manual no puede descuadrar el ledger, editar un saldo ni cambiar una tasa congelada.

## Pendiente

- **Prueba de penetración externa** por una empresa independiente antes de cobrar dinero real (la contrata luis: empresa y fecha por definir).
- Revisión de KYC desde el panel interno (hoy: `POST /internal/merchants/:id/status`).
- Recuperación de contraseña e invitación de usuarios; permisos por rol en el resto del panel.
- Avisos por correo (2FA activado o reiniciado, solicitudes aprobadas o rechazadas); no hay envío de correo todavía.
