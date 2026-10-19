# Núcleo transaccional: Ledger multi-moneda + máquina de estados del PaymentIntent

Primer bloque del "Stripe venezolano": el motor contable de doble partida y el ciclo de vida de un cobro,
con la tasa de cambio congelada desde que el pagador confirma. NestJS + TypeScript, PostgreSQL 16, Redis.

## Cómo correrlo

Todo en Docker (API, PostgreSQL, Redis y las tareas de desarrollo), con la configuración de `.env.development`:

```bash
docker compose up -d --build         # migra al arrancar; http://localhost:3000/health responde {"ok":true}
docker compose run --rm seed         # usuario del panel (dev@paguara.test / paguara-dev-123) y llaves sk_test_/pk_test_
```

El servicio `dev-jobs` carga tasas **fijas** (`DEV_FX_RATES`) cada hora y vence los cobros abandonados cada minuto.
Sin él, los cobros en VES fallan con `fx_rate_unavailable` porque todavía no existe el job real de tasas. Se niega a correr con `LIVEMODE=true`.

Sin Docker para la app (solo la base y Redis en contenedores):

```bash
docker compose up -d postgres redis
set -a; . ./.env.development; set +a
npm install
npm run migrate                      # aplica db/migrations/*.sql
npm test                             # 23 pruebas unitarias
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:integration   # 31 pruebas contra PostgreSQL real
npm run build && npm start           # en otras terminales: npm run dev:jobs y npm run seed
```

`.env.development` no tiene secretos y relaja lo que exige HTTPS (`COOKIE_SECURE=false`, webhooks a `http://`). Para un entorno público
parte de `.env.example`, con un `INTERNAL_API_TOKEN` propio y `COOKIE_SECURE=true`.

### Desplegar el entorno de desarrollo en Railway

1. Nuevo proyecto desde el repo de GitHub; Railway detecta el `Dockerfile` (la imagen migra y arranca la API). Healthcheck: `/health`.
2. Agregar PostgreSQL y Redis al proyecto y pasar sus URLs a la API como `DATABASE_URL` y `REDIS_URL`.
3. Variables: las de `.env.development`, cambiando `INTERNAL_API_TOKEN` por uno aleatorio, `PUBLIC_BASE_URL` por el dominio que asigne Railway,
   `COOKIE_SECURE=true`, `WEBHOOK_ALLOW_PRIVATE=false` y `TRUST_PROXY=1`.
4. Segundo servicio desde el mismo repo con comando de inicio `node dist/scripts/dev-jobs.js` y `APP_URL` apuntando a la API.
5. Una vez: `railway run npm run seed` con `APP_URL` igual a la URL pública y `SEED_PASSWORD` con una clave propia (en un entorno público el seed no usa la de ejemplo).

CI (`.github/workflows/ci.yml`) corre typecheck, pruebas unitarias y de integración, construye la imagen y busca secretos con gitleaks en cada PR.

### Secretos

- Nunca se versiona un `.env` con valores reales: `.gitignore` solo deja pasar `.env.example` y `.env.development` (ficticios).
  En Railway los secretos van en *Variables* del servicio, no en archivos.
- Con `COOKIE_SECURE` distinto de `false` o `LIVEMODE=true` la API no arranca si `INTERNAL_API_TOKEN` es el de ejemplo o tiene menos de 32 caracteres.
  Generar uno con `openssl rand -hex 32`.
- Rotación: `INTERNAL_API_TOKEN` se cambia en Variables y se reinician la API y `dev-jobs`; las llaves `sk_` de un comercio se rotan con
  *Rotar* en el panel (crea una nueva y revoca la anterior); el secreto `whsec_` de un webhook, borrando el endpoint y creándolo de nuevo.
- En tu máquina, `pre-commit install` activa gitleaks antes de cada commit (`.pre-commit-config.yaml`).

## Ciclo de vida de un PaymentIntent

```
requires_payment_method ─attach─▶ requires_confirmation ─confirm─▶ processing ─▶ succeeded ─payout─▶ settled
         ▲                                                       │   ▲
         │                                                       ▼   │
         └───────────── rechazo del riel ◀────────────── requires_action
                                                (OTP C2P, 3DS, transferir P2P/Zelle, enviar USDT)
cancel: desde requires_payment_method, requires_confirmation o requires_action
```

| Paso | Qué pasa | Dónde |
|---|---|---|
| `attach` | Se elige el método → riel y moneda de cobro. Si difiere de la moneda del precio se **cotiza la tasa** (BCV, Binance P2P…) en `fx.quotes` con vencimiento (5–30 min según riel). Se calcula comisión, IVA 16 % sobre la comisión y neto. | `PaymentIntentsService.attachPaymentMethod` |
| `confirm` | Si la cotización venció → `409 fx_quote_expired` (hay que re-adjuntar para mostrar el nuevo monto). Si no, se persiste `processing` **antes** de llamar al riel. Desde aquí la tasa queda congelada en la BD. | `confirm` |
| riel | Se llama fuera de la transacción. Timeout = el intent queda en `processing` para el reconciliador (marcarlo fallido podría duplicar un cobro). | `rails/*.ts` |
| `succeeded` | En la **misma transacción**: asiento de captura + cambio de estado. Webhooks duplicados no duplican el asiento. | `applyRailResult` |
| fondos recibidos | Conciliación del lote del banco: el neto pasa de "por recibir" a "disponible". | `SettlementsService.recordRailFunds` |
| `settled` | Corte de lote: por comercio, aplica su regla de split (p. ej. 60 % VES / 40 % USDT), congela una cotización por porción convertida, cobra el spread y deja instrucciones de pago para tesorería. | `SettlementsService.runCutoff` |

## Modelo contable

- Montos en `bigint` de unidades mínimas (VES/USD 2 decimales, USDT 6). Tasas en `numeric(30,12)`, convertidas con aritmética entera y redondeo bancario. Ningún `float`.
- Signo: débito `+`, crédito `−`. **Cada asiento cuadra a cero por moneda**; las conversiones pasan por cuentas `platform:fx_position:<MON>`.
- Plan de cuentas (se crean solas al primer uso), en `src/ledger/chart-of-accounts.ts`:

| Cuenta | Tipo | Para qué |
|---|---|---|
| `platform:rail_clearing:<riel>:<MON>` | activo | lo que el banco/riel nos debe por cobros aprobados |
| `platform:cash:<MON>` | activo | bancos y tesorería (VES nacional, USD Panamá, wallet USDT) |
| `platform:fee_revenue:<MON>` | ingreso | MDR |
| `platform:fx_spread_revenue:<MON>` | ingreso | spread cambiario al convertir liquidaciones |
| `platform:tax_payable:iva:<MON>` | pasivo | IVA sobre la comisión |
| `platform:tax_payable:igtf:<MON>` | pasivo | IGTF 3 % retenido en pagos en divisas en efectivo |
| `platform:fx_position:<MON>` | patrimonio | posición cambiaria por conversiones |
| `merchant:<id>:pending:<MON>` | pasivo | cobrado, aún no recibido del riel |
| `merchant:<id>:available:<MON>` | pasivo | recibido, disponible para liquidar |

Ejemplo real de las pruebas (100 USD cobrados por Pago Móvil, BCV 36,5):

```
Captura          Dr rail_clearing:ves_c2p:VES  3.650,00
                 Cr merchant:m_1:pending:VES  −3.584,38
                 Cr fee_revenue:VES              −56,57   (1,5 % + 0,05 USD)
                 Cr tax_payable:iva:VES           −9,05   (16 % de la comisión)
Fondos del banco Dr cash:VES 3.650,00 / Cr rail_clearing −3.650,00
                 Dr merchant pending 3.584,38 / Cr merchant available −3.584,38
Liquidación      Dr available 1.433,75 / Cr fx_spread_revenue:VES −17,20             (40 %, spread 1,2 %)
60/40 VES/USDT                          Cr fx_position:VES −1.416,55
                 Dr fx_position:USDT 37,082461 / Cr cash:USDT −37,082461            (… a 38,2 Bs/USDT)
                 Dr available 2.150,63 / Cr cash:VES −2.150,63                       (60 % en Bs, absorbe el redondeo)
```

## Garantías que impone la base de datos (no solo la app)

| Regla | Mecanismo |
|---|---|
| Asiento descuadrado por moneda o con < 2 partidas | constraint trigger diferido al COMMIT (`P0004`) |
| Partida en moneda distinta a la de su cuenta | trigger (`P0002`) |
| Comercio con saldo negativo / activo en rojo | trigger que mantiene `account_balances` (`P0003`) |
| `UPDATE`/`DELETE`/`TRUNCATE` en postings, asientos, cotizaciones, historial | triggers append-only (`P0005`) |
| Editar un saldo a mano (`UPDATE account_balances`) | trigger: solo el trigger de postings puede moverlo (`P0005`) |
| Transición no permitida (p. ej. cancelar algo cobrado) | `payments.allowed_transitions` + trigger (`P0011`) |
| Cambiar monto, moneda o tasa desde `processing` | trigger (`P0012`) |
| `succeeded` sin asiento de captura, `settled` sin fondos recibidos ni liquidación | `CHECK` |
| `charge = comisión + IVA + neto + IGTF` | `CHECK` |

Concurrencia: lock de fila del intent (`FOR UPDATE`) en cada transición; partidas insertadas en orden de `account_id` para que asientos concurrentes no hagan deadlock; reintento automático ante `40001`/`40P01`. Auditoría: las vistas `ledger.balance_drift` y `ledger.trial_balance` deben estar vacías / en cero.

Idempotencia: `Idempotency-Key` obligatorio en todo POST (Redis `SET NX`): repite la respuesta guardada, `409` si la misma llave está en curso, `422` si se reusa con otro cuerpo. Aunque Redis falle, la BD impide el doble cobro (lock + estado + llave única del asiento).

## Checkout web

Página alojada al estilo Stripe Checkout en `public/checkout.html`, servida por la API en
`GET /checkout?pi=<id>&cs=<client_secret>&pk=<pk_test_...>`. Solo usa la API del checkout (llave
publicable + `client_secret`): elige método, muestra el monto en la moneda del riel con la tasa
congelada y su cuenta regresiva, pide los datos de Pago Móvil C2P, muestra instrucciones para P2P,
Zelle, USDT (con QR) y efectivo, y se actualiza sola cuando el riel confirma. Sin parámetros corre en
modo demostración con montos de ejemplo. Capturas contra la API real en `docs/capturas/`.

Diseño: una sola columna tipo recibo. El boleto amarillo con la tasa congelada aparece junto a la
acción que cotiza y es el único lugar con tipografía monoespaciada. Contraste WCAG 2.1 AA verificado
en modo claro y oscuro (texto ≥ 4,5:1, bordes de campos ≥ 3:1) y auditoría axe-core sin violaciones
en las 8 pantallas del flujo. El nombre de la pasarela es provisional: se cambia en la constante
`BRAND` al inicio del script.

## Web: sitio, dashboard y documentación

`GET /` sirve `public/site.html` (+ `public/assets/`), una sola página con rutas por hash:
sitio público con precios (`#/`), documentación (`#/docs`), registro e inicio de sesión
(`#/registro`, `#/entrar`) y el dashboard del comercio (`#/dashboard/...`: inicio, pagos con
detalle y línea de tiempo, saldos y reglas de liquidación, links de pago, llaves API, webhooks y
eventos, ajustes y activación de la cuenta). Abierta fuera del servidor corre en modo
demostración con datos de ejemplo. El nombre de la marca es provisional: constante `BRAND` en
`public/assets/site.js`.

La API que usa está en [`docs/dashboard-api.md`](docs/dashboard-api.md). Puntos de seguridad:
- Contraseñas con scrypt; sesión en cookie `HttpOnly; SameSite=Lax; Secure`, y en la BD solo el
  SHA-256 del token. 10 intentos fallidos por correo (50 por IP) bloquean 15 minutos.
- Todo pedido que modifica algo exige `X-Requested-With: fetch` (CSRF).
- La llave publicable se guarda en claro (es pública por diseño); las secretas, solo como hash y
  se muestran una vez.
- Registro: el comercio queda con KYC pendiente y solo puede usar el sandbox hasta que
  cumplimiento lo active.

**Webhooks** con outbox transaccional: cada cambio de un pago inserta su evento en la misma
transacción, y un worker los entrega con `Webhook-Signature: t=<unix>,v1=<HMAC-SHA256(secreto,
"t.cuerpo")>`, reintentando 8 veces con espera exponencial (30 s a 32 min). Solo https y nunca a
direcciones internas (se valida la IP con la que realmente se conecta, no solo la URL).

**Links de pago:** `/pay/<slug>` crea un PaymentIntent nuevo con el monto del link y redirige al
checkout (30 por minuto por IP).

## API (v1)

Servidor del comercio, `Authorization: Bearer sk_test_...` (o `sk_live_...` en producción):
```
POST /v1/payment_intents                {amount, currency, customer?, metadata?, expires_in?, payment_method_types?}  → incluye client_secret
POST /v1/payment_intents/:id/attach     {payment_method_type, fx_source?}
POST /v1/payment_intents/:id/confirm    {payment_method_details}   ← OTP/tokens se usan y se descartan
POST /v1/payment_intents/:id/cancel     {cancellation_reason?}
GET  /v1/payment_intents/:id
GET  /v1/account/capabilities                                   ← métodos y módulos de la cuenta y su estado
POST /v1/account/capabilities/:key      {enabled}
```
Checkout en el navegador, `Authorization: Bearer pk_test_...` + `client_secret` del intent (no ve metadata ni puede cancelar):
```
GET  /v1/checkout/payment_intents/:id?client_secret=...      ← incluye payment_methods: solo los que el pagador puede elegir
POST /v1/checkout/payment_intents/:id/attach    {client_secret, payment_method_type}
POST /v1/checkout/payment_intents/:id/confirm   {client_secret, payment_method_details}
```
Internos y panel (`X-Internal-Token`): comercios y KYC (`/internal/merchants`, `/:id/status`, `/:id/api_keys`, `/:id/settlement_rules`), interruptores (`/internal/capabilities/:key` global, `/internal/merchants/:id/capabilities[/:key]` por comercio), tasas (`/internal/fx/rates`), resultado de rieles (`/internal/payment_intents/:id/rail_result`), conciliación (`/internal/rail_batches`), corte de lote (`/internal/settlement_batches`) y vencimientos (`/internal/payment_intents/expire`).

Montos en la API como string de enteros en unidades mínimas, para no perder precisión en JavaScript. Sandbox y producción son despliegues separados (`LIVEMODE`), cada uno con su base: una llave de un ambiente es rechazada en el otro y un pago de prueba nunca toca el ledger real.

## Métodos y módulos por comercio

Cada comercio enciende o apaga sus métodos de pago y módulos (links de pago, webhooks, liquidar en USDT o USD)
dentro de lo que la plataforma le permite. Operaciones aprueba solicitudes y apaga métodos para todos desde el
panel interno en `/admin`. La regla vive en SQL (`merchants.capability_state`, migración 008) y la usan la API, el
checkout, el panel y el outbox de webhooks. Diseño, estados, errores y endpoints en
[docs/modulos-por-comercio.md](docs/modulos-por-comercio.md).

## Comparación con la guía de arquitectura

| De la guía | Decisión | Por qué |
|---|---|---|
| Tabla `merchants` con RIF, estado KYC, webhook URL/secret | **Adoptado** | RIF validado y único; `pending_kyc` permite llaves de prueba, las live exigen `active`. |
| `ApiKeyGuard` con `sk_`/`pk_` y hash SHA-256 | **Adoptado** | Además: `pk_` solo para checkout con `client_secret`, revocación, `last_used_at`, y separación sandbox/producción. Reemplaza el `X-Merchant-Id` provisional. |
| `client_secret` y `expires_at` en el intent | **Adoptado** | Para el checkout y los links de WhatsApp abandonados. Al vencer se cancela solo si no movió dinero; si espera una transferencia, decide el riel. |
| `UNIQUE(merchant_id, idempotency_key)` | **Adoptado** | Respaldo durable de Redis: aunque Redis pierda la llave, no se crea un segundo intent. |
| `customer_info` | **Adoptado** como `customer` | Datos del pagador para riesgo y conciliación. |
| `running_balance` por partida | **Adoptado** como `balance_after` | Estados de cuenta sin recalcular. |
| Banesco Panamá como riel | **Adoptado** | Método `banesco_panama` (USD, 2,5 % + 0,25). |
| Spread de cobertura 1,2 % | **Adoptado con cambios** | Solo al convertir liquidaciones, nunca al cobrar a tasa BCV. Se registra como ingreso visible (`fx_spread_revenue`), con aritmética exacta; la guía usaba `parseFloat`/`Number`, que pierde céntimos. |
| Corte de lote de liquidación | **Adoptado con cambios** | Se arma desde los intents cobrados con fondos ya recibidos (no escaneando saldos), así cada intent queda `settled` y trazable. Usa la regla de split de cada comercio, un monto mínimo y un comercio por transacción. Deja `payout_instructions` para que tesorería genere el ACH o envíe USDT. |
| `current_balance` editable en `ledger_accounts` | **No adoptado** | Un saldo editable es justo lo que el ledger evita. El saldo vive aparte y la BD rechaza cualquier `UPDATE` que no venga de un asiento. |
| Tasas `NUMERIC(18,6)` y cálculos con `float` | **No adoptado** | Se mantiene `numeric(30,12)` y `bigint`; 6 decimales no alcanzan para USDT/VES invertido. |
| Estados `failed`, `refunded`, `disputed` en el intent | **No adoptado** | Un rechazo vuelve a `requires_payment_method` para reintentar (como Stripe). Reembolsos parciales y contracargos serán objetos propios con sus asientos, no un estado. |
| `ENUM` de monedas | **No adoptado** | La tabla `ledger.currencies` con exponente permite agregar EUR u otra cripto sin migrar tipos. |
| Oráculo con `@Cron` y caché en Redis | **Pendiente** | Las tasas de la guía son fijas (simuladas). El job real leerá BCV y Binance P2P y llamará a `/internal/fx/rates`; la consulta por índice en PostgreSQL ya es rápida sin caché. |
| Archivo ACH y cola BullMQ de USDT | **Pendiente** | El formato de ancho fijo depende de cada banco. Los dispersores leerán `payout_instructions` pendientes. |
| Checkout en Next.js | **Pendiente** | El componente de la guía marca el pago como exitoso sin llamar a la API. La API del checkout ya existe; el componente debe usarla con `pk_` y `client_secret`. |

## Lo que falta

- **Rieles reales:** hoy todos usan `SandboxRail` (teléfono terminado en `0002` → fondos insuficientes, `0003` → clave C2P inválida). Cada conector (C2P, ISO 8583, Banesco Panamá, Zelle, TRON) implementa `RailAdapter`.
- **Job de tasas** (BCV, Binance P2P, USD/USDT del exchange).
- **Recuperar contraseña e invitar a otros usuarios** del comercio (la tabla de usuarios ya tiene roles).
- **Panel interno** para revisar el KYC enviado desde el dashboard y aprobarlo (hoy: `POST /internal/merchants/:id/status`).
- **Reembolsos, contracargos y reserva (rolling reserve):** los tipos de asiento existen, los flujos no.
- **Reconciliador** para intents que quedaron en `processing` por timeout del riel.
- **Decisión pendiente:** la fuente de tasa por defecto por comercio (hoy BCV para USD/VES, Binance P2P para USDT/VES).

## Decisiones de negocio aplicadas

- **IGTF 3 %:** solo en pagos en divisas en efectivo (método `cash`). Lo paga el pagador encima del precio (50,00 USD → entrega 51,50) y queda en `platform:tax_payable:igtf:USD`. El comercio recibe su precio menos la comisión, sin tocar el IGTF. Se configura con `igtfBps` en `payment-methods.ts`.
- **Comisión fija en USDT:** se convierte con la tasa USD/USDT del exchange que use la plataforma (fuente `EXCHANGE` en `fx.rates`), no 1:1. Si no hay tasa `EXCHANGE` reciente, el método USDT responde `fx_rate_unavailable`.
