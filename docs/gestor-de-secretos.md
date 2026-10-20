# Gestor de secretos (KMS) y secretos de los bancos

Todo secreto que la API guarda en la base y necesita en claro (secretos de webhooks `whsec_`, semillas de doble factor,
llaves y certificados de los bancos) se cifra **por sobre** (envelope) con un gestor de llaves. Código en `src/secrets/`.

## Cifrado por sobre (`src/secrets/vault.ts`, `src/secrets/kms.ts`)

1. Para cada secreto se pide al KMS una llave de datos (DEK) de 256 bits: llega en claro y envuelta por la llave maestra.
2. El secreto se cifra con la DEK (AES-256-GCM, IV de 12 bytes); la DEK en claro se borra de memoria.
3. Se guarda `env:v1:<keyId>:<DEK envuelta>:<iv>:<tag>:<cifrado>` (base64url).
4. Para leer, el KMS desenvuelve la DEK. Las DEK ya desenvueltas se guardan 10 minutos en memoria (máximo 1.000) para
   no llamar al KMS en cada webhook.

El **propósito** (`webhook_secret`, `mfa:user:<id>`, `rail:<riel>:<nombre>`) va como contexto de cifrado del KMS y como
AAD del AES-GCM: un valor copiado a otra fila o columna no se abre. La llave maestra nunca sale del KMS.

| Proveedor (`KMS_PROVIDER`) | Llave maestra | Uso |
|---|---|---|
| `aws` | `KMS_KEY_ID` en AWS KMS (ARN, id o alias). La API solo necesita `kms:GenerateDataKey` y `kms:Decrypt` sobre esa llave | **Producción** (obligatorio con `LIVEMODE=true`) |
| `local` (por defecto) | `SECRETS_ENCRYPTION_KEY` (64 hex) en las variables del hosting | Desarrollo y sandbox |
| sin llave | — (se guarda en claro) | Solo desarrollo local; desplegada la API no arranca así |

Credenciales de AWS: las del rol del servicio (IAM role, `AWS_*` del entorno o el perfil), por la cadena estándar del
SDK (`@aws-sdk/client-kms`); la región sale de `AWS_REGION`. Otro proveedor (Google Cloud KMS, Vault Transit) se
agrega implementando `KeyProvider` (`generateDataKey`, `decryptDataKey`, `isActive`).

Se siguen leyendo los formatos anteriores: `enc:v1:` (AES-256-GCM directo con `SECRETS_ENCRYPTION_KEY`, hasta este
cambio) y valores en claro (antes de cifrar).

## Rotación

`npm run secrets:rewrap` (`scripts/rewrap-secrets.ts`, `src/secrets/rewrap.ts`) vuelve a cifrar con la llave activa
todo lo que esté con una llave vieja, en `enc:v1:` o en claro. Es idempotente; `-- --dry` solo cuenta.

| Caso | Pasos |
|---|---|
| Rotar la llave local | `SECRETS_ENCRYPTION_KEY=<nueva>`, `SECRETS_ENCRYPTION_PREVIOUS_KEYS=<vieja>`, reiniciar, `npm run secrets:rewrap`, quitar la vieja |
| Pasar a AWS KMS | `KMS_PROVIDER=aws`, `KMS_KEY_ID=...`, dejar `SECRETS_ENCRYPTION_KEY` (para leer lo viejo), reiniciar, `npm run secrets:rewrap`, quitar `SECRETS_ENCRYPTION_KEY` |
| Rotar en AWS | Activar la rotación automática anual de la llave en AWS: el id no cambia y no hace falta rewrap |

Columnas que cubre el rewrap: `webhooks.endpoints.secret`, `merchants.merchants.webhook_secret`,
`security.mfa_factors.secret_sealed`, `platform.rail_credentials.sealed`. Un secreto nuevo en la base se agrega a
`SEALED_COLUMNS` en `src/secrets/rewrap.ts`.

## Secretos de los bancos (`src/secrets/rail-credentials.service.ts`)

Llaves de API del C2P, usuario y clave del web service, certificado TLS cliente, su llave privada o el `.p12` que entrega
cada banco. Tabla `platform.rail_credentials` (migración 014):

- `sealed` con `CHECK (sealed LIKE 'env:v1:%')`: la base rechaza un secreto en claro aunque la app tenga un bug, y sin
  KMS la API no lo guarda (503 `kms_unavailable`).
- Versionado: cargar el mismo `rail`/`name` crea la versión siguiente y retira la anterior (no se borra).
  Índice único de la versión vigente.
- `fingerprint`: SHA-256 del valor, para comparar sin descifrar (`same_as_previous` al cargar).
- Certificados en PEM: se valida y se guarda `expires_at`; el job diario alerta los que vencen en menos de 30 días
  (`certificate_expiring`). Llave privada en PEM; `.p12` en base64; máximo 64 KB.
- El valor no sale por ninguna ruta HTTP: `list()` devuelve metadatos y `reveal(rail, name)` es solo para los
  conectores de los rieles.

| Ruta | Cuerpo | Quién | Qué hace |
|---|---|---|---|
| `GET /internal/rail_credentials` | — | `secrets:read` | Vigentes, sin valor |
| `POST /internal/rail_credentials` | `{rail, name, kind: 'api_key'\|'password'\|'certificate'\|'private_key'\|'pkcs12', value}` | `secrets:manage` | Carga una versión nueva |
| `POST /internal/rail_credentials/:rail/:name/retire` | — | `secrets:manage` | Retira la vigente |

En `/admin` → *Secretos de los bancos* se cargan pegando el valor o eligiendo el archivo (el `.p12` se pasa a base64
en el navegador).

## Pendiente

- Los conectores reales de los bancos (que llamarán `reveal`) todavía no existen; ver [metodos-de-pago.md](metodos-de-pago.md).
- Probar el proveedor AWS contra una cuenta real (las pruebas usan un cliente KMS falso con el mismo contrato).
