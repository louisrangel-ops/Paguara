# Panel total de administración de Paguara y RBAC

El panel interno `/admin` es la consola operativa de Paguara. Solo se sirve por `INTERNAL_PORT` y requiere
un token personal `opk_…`. El token de procesos `INTERNAL_API_TOKEN` no sirve para iniciar sesión en el panel.

## Roles internos

| Rol | Alcance |
|---|---|
| `master` | Superadministración: todos los permisos, usuarios internos, llaves, KYC, ISO 8583, métodos, plataforma, tesorería y workers manuales |
| `compliance` | Revisión del comercio, KYC, cambio de estado y provisionamiento MCC/MID/TID/perfil ISO 8583 |
| `operations` | Comercios operativos, métodos y módulos por contrato, precios/límites e interruptores globales |
| `treasury` | Liquidaciones, doble aprobación, reglas de liquidación y aportes de tesorería |
| `support` | Consulta de comercios y capacidades, sin cambios sensibles |
| `auditor` | Solo lectura de operadores, comercios, capacidades y liquidaciones |
| `operator` | Rol legado: lectura operativa y aprobación de liquidaciones; se conserva por compatibilidad |

El servidor no confía en lo que oculta la interfaz: cada endpoint vuelve a validar el permiso.

## Permisos

Los permisos efectivos salen de `operatorPermissions(role)` en `src/settlements/operators.service.ts`:

- `operators:read`, `operators:manage`
- `merchants:read`, `merchants:manage`, `merchants:status`, `merchants:api_keys`
- `iso8583:manage`
- `capabilities:read`, `capabilities:manage`, `platform:manage`
- `payouts:read`, `payouts:approve`
- `settlement:manage`, `treasury:contribute`
- `workers:run`

`GET /internal/whoami` devuelve el rol y la lista de permisos; `public/admin.html` usa esa lista para mostrar
solo las secciones y acciones autorizadas.

## Gestión de operadores

Un `master` puede:

- crear una persona con rol;
- reasignar su rol con `POST /internal/operators/:id/role`;
- revocar acceso;
- consultar el historial de cambios de rol.

No puede cambiarse su propio rol ni revocarse a sí mismo. Tampoco se permite dejar la plataforma sin al menos un
maestro activo.

La migración 013 agrega `platform.operator_role_changes`, append-only, para auditar cambios de rol.

## Administración de comercios

La sección **Comercios** permite buscar por nombre, RIF o `acct_…`, y filtrar por estado. La ficha reúne:

- estado de la cuenta;
- KYC y onboarding;
- perfil ISO 8583;
- métodos/módulos, contrato, comisión y límites;
- creación controlada de llaves API para roles autorizados.

Separación de responsabilidades:

- cumplimiento decide KYC/estado/perfil ISO 8583;
- operaciones gestiona capacidades y parámetros comerciales;
- tesorería gestiona liquidaciones;
- soporte/auditor consultan sin poder escribir;
- master puede realizar cualquier acción.

## ISO 8583

El panel permite a cumplimiento o master provisionar los datos técnicos asignados por el adquirente:

- MCC / DE18;
- acquiring institution / DE32;
- TID / DE41;
- MID / DE42;
- moneda / DE49;
- POS Entry Mode / DE22;
- POS Condition Code / DE25.

No se introducen PAN, CVV, PIN, track, criptogramas ni credenciales 3DS en el panel.

## Operaciones de plataforma

El panel conserva las bandejas existentes:

- liquidaciones por aprobar;
- solicitudes de métodos/módulos;
- interruptores globales;
- capacidades por comercio.

Los endpoints de workers (tasas, reconciliación, resultados de riel, corte, vencimientos) aceptan el token de
sistema o un `master` con `workers:run`; los demás roles no pueden dispararlos.

## Seguridad

- Solo red privada/VPN mediante `INTERNAL_PORT`.
- Tokens personales hasheados con SHA-256 en la base y mostrados una sola vez.
- Revocación inmediata.
- RBAC validado en servidor.
- Historial de cambios de rol append-only.
- Al menos un master activo.
- Acciones de capacidades registran `platform:<nombre>`.
- Se mantiene pendiente 2FA obligatorio antes de producción financiera real.
