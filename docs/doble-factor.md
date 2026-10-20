# Doble factor (2FA)

Código de una app autenticadora (TOTP, RFC 6238) más 10 códigos de respaldo de un solo uso. Lo comparten el panel del
comercio (opcional) y el panel interno `/admin` (obligatorio). Migración 014, `src/mfa/`.

## Cómo funciona

| Pieza | Detalle | Dónde |
|---|---|---|
| Código | HMAC-SHA1, 6 dígitos, pasos de 30 s; se acepta un paso antes y uno después (±30 s de reloj) | `src/mfa/totp.ts` |
| Semilla | 160 bits en base32, **cifrada por sobre con el KMS** (`purpose = mfa:<user\|operator>:<id>`) en `security.mfa_factors.secret_sealed` | `mfa.service.ts`, [gestor-de-secretos.md](gestor-de-secretos.md) |
| Sin repetición | Se guarda el último paso aceptado (`last_used_step`): el mismo código no vale dos veces, ni uno anterior | `MfaService.verify` |
| Códigos de respaldo | 10, formato `xxxxx-xxxxx` (sin letras que se confunden, ~50 bits), solo su SHA-256 en `security.mfa_recovery_codes`; se gastan al usarlos; se aceptan con o sin guion y en mayúsculas | `totp.ts`, `mfa.service.ts` |
| Bloqueo | 5 códigos malos seguidos por persona → 429 `too_many_attempts` durante 15 min (Redis `mfa:fail:<tipo>:<id>`), también para el código correcto | `MfaService` |
| Auditoría | `security.mfa_audit` append-only: `enrolled`, `disabled`, `reset`, `recovery_code_used`, `recovery_codes_regenerated`, con actor y motivo | migración 014 |

Inscripción en dos pasos: `beginEnrollment` crea la semilla (sin proteger todavía, `confirmed_at` nulo) y devuelve el
enlace `otpauth://` para el QR; `confirmEnrollment` con el primer código la activa y entrega los códigos de respaldo
(se ven una sola vez). Un factor a medias se reemplaza si se vuelve a empezar.

## Panel del comercio (opcional)

- **Login en dos pasos**: con el factor activo, `POST /api/dashboard/login` responde `{mfa_required: true, mfa_token}` y
  no abre sesión. `POST /api/dashboard/login/mfa {mfa_token, code}` la abre. El `mfa_token` vive 5 minutos en Redis
  (solo su SHA-256) y es de un solo uso; vencido → 401 `mfa_challenge_expired`.
- **Ajustes → Doble factor** (`public/assets/site.js`, `drawSecurity`): activar con QR (qrcodejs de cdnjs, cargado solo
  ahí) o la clave escrita, ver cuántos códigos de respaldo quedan, generar nuevos (pide un código) y quitarlo (pide
  contraseña y código).
- **Cambiar la cuenta de liquidación** (`PUT /api/dashboard/settlement_rules/:source`) con el factor activo exige
  `mfa_code` (403 `mfa_required` sin él). La web pide el código en un diálogo y reintenta.
- `Session.user.mfa_enabled` dice si está activo. Endpoints en [dashboard-api.md](dashboard-api.md#doble-factor).

## Panel interno (obligatorio)

El token del operador (`opk_…`) ya **no abre `/internal`** (401 `operator_session_required`). Con el token y el código
la persona recibe una sesión `ops_…` (`platform.operator_sessions`, solo su SHA-256) que dura `OPERATOR_SESSION_HOURS`
(8 h por defecto, máximo 24); es lo único que acepta el resto de `/internal` además del token de sistema.

| Ruta (sin guard) | Cuerpo | Qué hace |
|---|---|---|
| `POST /internal/auth/session` | `{token, code}` | Sin factor: `{mfa_enrollment_required: true}`. Con factor: `{session, expires_at, operator, used_recovery_code}` |
| `POST /internal/auth/mfa/setup` | `{token}` | Semilla y `otpauth_url` para el QR |
| `POST /internal/auth/mfa/confirm` | `{token, code}` | Activa el factor, devuelve `recovery_codes` y abre la sesión |
| `POST /internal/auth/logout` | cabecera `X-Internal-Token: ops_…` | Cierra la sesión |

20 tokens equivocados por IP en 15 minutos → 429. Revocar a un operador cierra todas sus sesiones. La página `/admin`
guarda solo la sesión `ops_` en `sessionStorage`; el `opk_` queda en memoria mientras se entra.

El token de sistema (`INTERNAL_API_TOKEN`) no tiene doble factor: es de procesos (cron, workers) y solo sirve en el
puerto interno con `LIVEMODE=true`.

## Reinicio seguro (perdió el teléfono y los códigos)

- **Operador**: otra persona con el permiso `security:manage` (hoy solo el rol `master`), nunca él mismo (409 `cannot_reset_self`), en `/admin` → Operadores → *Reiniciar 2FA*
  (`POST /internal/operators/:id/mfa/reset {reason}`). Se borra el factor, se cierran sus sesiones y en su próxima
  entrada vuelve a inscribirlo.
- **Usuario de un comercio**: alguien con `security:manage` en `/admin` → *Doble factor de un comercio*: busca por correo
  (`GET /internal/dashboard_users?email=`) y reinicia (`POST /internal/dashboard_users/:id/mfa/reset {reason}`); se
  cierran todas sus sesiones del panel.
- El motivo es obligatorio (10 a 300 caracteres, 400 `reason_required`) y debe decir cómo se verificó la identidad
  (videollamada con la cédula, correo desde la cuenta registrada). Queda en `security.mfa_audit` con el maestro.

## Pendiente

- Exigir 2FA a los roles `owner`/`admin` del comercio en producción (hoy es opcional para todos).
- Avisar por correo cuando se activa, se quita o se reinicia el doble factor (no hay envío de correo todavía).
- Llaves de seguridad (WebAuthn/passkeys) como segundo factor.
