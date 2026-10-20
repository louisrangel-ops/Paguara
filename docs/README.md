# Documentación técnica de Paguara

Documentación del código de la pasarela (NestJS + TypeScript, PostgreSQL 16, Redis). Describe lo que el
código hace hoy; cada afirmación remite al archivo donde vive. Si el código y esta documentación no
coinciden, el error es de la documentación: corrígela en el mismo PR.

| Documento | Contenido |
|---|---|
| [Arquitectura y módulos](arquitectura.md) | Procesos, módulos NestJS, flujo de un pedido, estructura del repo |
| [Modelo de datos y migraciones](modelo-de-datos.md) | Esquemas de PostgreSQL, tablas, triggers y lo que agregó cada migración 001–011 |
| [Ledger y plan de cuentas](ledger.md) | Doble partida multi-moneda, cuentas, plantillas de asientos, garantías de la BD |
| [Máquina de estados del PaymentIntent](payment-intents.md) | Estados, eventos, congelamiento de tasa, vencimiento, idempotencia |
| [Tasas de cambio (FX)](fx.md) | `fx.rates`, cotizaciones congeladas, fuentes, aritmética exacta |
| [Rieles y métodos de pago](metodos-de-pago.md) | Métodos, rieles, comisiones, IVA, IGTF, riel sandbox |
| [Métodos y módulos por comercio](modulos-por-comercio.md) | Interruptores de plataforma y del comercio, métodos por contrato, sandbox, precios negociados, panel interno `/admin` |
| [API y autenticación](api.md) | API v1, checkout, API interna, llaves, idempotencia, errores |
| [API del dashboard](dashboard-api.md) | Contrato web ↔ servidor del panel del comercio |
| [Webhooks](webhooks.md) | Outbox, eventos, firma, reintentos, protección SSRF |
| [Liquidaciones](liquidaciones.md) | Conciliación de fondos del riel, corte de lote en bolívares, spread y doble aprobación |
| [Configuración](configuracion.md) | Variables de entorno, una por una |
| [Despliegue, pruebas y CI](despliegue.md) | Docker, Railway, migraciones, seed, dev-jobs, pruebas, CI |
| [Web: diseño y movimiento](web.md) | Superficies web, proceso de diseño, reglas y presupuesto de las animaciones, cómo verificar un cambio visual |
| [Documentos legales](legal.md) | Términos, acuerdo de comercio, privacidad, cookies, uso aceptable, LC/FT, divulgación responsable; constancia de aceptación y `security.txt` |
| [Seguridad](seguridad.md) | Secretos, llaves, sesiones, CSRF, límites de peticiones, puerto interno, operadores, gitleaks |
| [CHANGELOG técnico](CHANGELOG.md) | Historial de cambios técnicos por PR |

Otros documentos del repo: [`README.md`](../README.md) (visión general y arranque rápido),
[`DESIGN.md`](../DESIGN.md) (sistema de diseño de la web) y [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Regla: todo cambio actualiza esta documentación

Todo PR que cambie código, esquema de base de datos, API, configuración o despliegue debe, **en el mismo PR**:

1. Actualizar el documento de esta carpeta que describe lo que cambió (o crear uno nuevo y enlazarlo en la tabla de arriba).
2. Agregar una entrada en [`CHANGELOG.md`](CHANGELOG.md) bajo **Sin publicar**.

La plantilla de PR (`.github/pull_request_template.md`) tiene una casilla para confirmarlo. Detalle en [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Convenciones de esta documentación

- Español. Nombres de código, tablas, rutas y variables, tal como están en el repo.
- Montos en unidades mínimas (`bigint`): VES, USD y EUR con 2 decimales, USDT con 6.
- Se cita la fuente (`src/...`, `db/migrations/...`) para que se pueda verificar.
- Lo que no existe todavía se marca como **Pendiente**, nunca se describe como hecho.
