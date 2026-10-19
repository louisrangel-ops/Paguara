# Seguridad

## Secretos y configuración

- Solo se versionan `.env.example` y `.env.development` (ficticios). `.gitignore` y `.dockerignore` excluyen todo otro `.env*`,
  llaves (`*.pem`, `*.key`, `*.p12`, `*.pfx`) y volcados (`*.rdb`, `*.aof`, `*.dump`, `*.sql.gz`).
- En hosting, los secretos van en las variables del servicio, no en archivos.
- **Chequeo al arrancar** (`src/common/secrets-check.ts`, llamado en `main.ts`): si `LIVEMODE=true` o `COOKIE_SECURE`
  no es `false`, la API no arranca cuando `INTERNAL_API_TOKEN` es un valor de ejemplo (`cambia-esto`, `dev-internal-token`)
  o tiene menos de 32 caracteres, ni cuando se combina `LIVEMODE=true` con `COOKIE_SECURE=false`.
- `seed` exige `SEED_PASSWORD` propio fuera de local; `seed` y `dev-jobs` no corren con `LIVEMODE=true`.
- **gitleaks** en CI sobre todo el historial y, opcional, en local con `pre-commit install` (`.pre-commit-config.yaml`).
  Excepciones en `.gitleaks.toml` (solo los datos de demo de `public/assets/site-demo.js` y referencias `pedido-N-x`).
- Auditoría del 2026-10-19: sin secretos reales en el historial.

## Rotación

| Secreto | Cómo |
|---|---|
| `INTERNAL_API_TOKEN` | Cambiar la variable y reiniciar la API y `dev-jobs` |
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
- Registro: el comercio nace `pending_kyc` y solo opera con llaves de prueba hasta que cumplimiento lo active.

## Checkout y links de pago

- El `client_secret` viaja en la URL del checkout: la página responde con `Referrer-Policy: no-referrer` y `Cache-Control: no-store`.
- El `client_secret` se compara en tiempo constante; si no coincide, 404 sin detalles.
- `/pay/:slug`: 30 visitas por minuto por IP; el slug se valida antes de consultar.
- El sitio se sirve con `X-Frame-Options: DENY`.

## Panel interno (`/admin`)

La página no trae datos: el operador escribe el `INTERNAL_API_TOKEN` y su nombre (va como `actor` a la auditoría
`merchants.capability_changes`). El token queda en `sessionStorage` y se borra al cerrar la pestaña. Se sirve con
`Cache-Control: no-store`, `X-Frame-Options: DENY` y `Referrer-Policy: no-referrer`.

## Webhooks

Firma HMAC-SHA256 y protección SSRF por IP efectiva de conexión: [webhooks.md](webhooks.md#protección-ssrf).

## Base de datos

Las reglas de dinero se imponen también con triggers y `CHECK` ([modelo-de-datos.md](modelo-de-datos.md)): un bug de la
app o un `UPDATE` manual no puede descuadrar el ledger, editar un saldo ni cambiar una tasa congelada.

## Pendiente

- Cifrado con KMS de `webhooks.endpoints.secret` y `merchants.webhook_secret` (hoy en claro: se necesitan para firmar).
- Autenticación propia para el panel interno (hoy: el token interno compartido) y revisión de KYC desde ahí (hoy: `POST /internal/merchants/:id/status`).
- Recuperación de contraseña e invitación de usuarios; permisos por rol en el resto del panel.
