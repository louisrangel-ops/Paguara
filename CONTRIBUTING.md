# Cómo contribuir a Paguara

## Regla de documentación (obligatoria)

Todo PR que cambie **código, esquema de base de datos, API, configuración o despliegue** debe, en el mismo PR:

1. **Actualizar la documentación técnica** en [`docs/`](docs/README.md): el documento que describe lo que cambió.
   Si nada lo describe, crear uno y enlazarlo en el índice `docs/README.md`.
2. **Agregar una entrada al [CHANGELOG técnico](docs/CHANGELOG.md)** bajo *Sin publicar*, con el área y el número de PR.

Un PR sin esas dos cosas no se fusiona. La plantilla de PR tiene una casilla para confirmarlo.

Qué actualizar según el cambio:

| Si cambias… | Actualiza |
|---|---|
| Una migración nueva en `db/migrations/` | `docs/modelo-de-datos.md` (sección de la migración) y el documento del área |
| Rutas, cuerpos, respuestas o códigos de error | `docs/api.md` o `docs/dashboard-api.md` |
| Estados o eventos del PaymentIntent | `docs/payment-intents.md` (y `payments.allowed_transitions` en una migración) |
| Cuentas o plantillas de asientos | `docs/ledger.md` |
| Tasas, fuentes o TTL | `docs/fx.md` |
| Métodos, rieles o precios | `docs/metodos-de-pago.md` |
| Eventos o entrega de webhooks | `docs/webhooks.md` |
| Conciliación o corte de lote | `docs/liquidaciones.md` |
| Variables de entorno | `docs/configuracion.md`, `.env.example` y `.env.development` |
| Docker, CI, scripts o hosting | `docs/despliegue.md` |
| Autenticación, secretos o límites | `docs/seguridad.md` |

Cambios que no necesitan documentación técnica: solo textos de la web, solo estilos o solo pruebas. Igual se
agradece una línea en el CHANGELOG si el cambio es visible.

## Otras reglas

- No se edita una migración ya fusionada: se agrega una nueva con el siguiente número.
- Dinero siempre en `bigint` de unidades mínimas y tasas como string decimal; nunca `float`.
- Antes de abrir el PR: `npm run typecheck`, `npm test` y `npm run test:integration` (con `DATABASE_URL`).
- Nunca se versionan secretos reales (ver [`docs/seguridad.md`](docs/seguridad.md)); CI corre gitleaks.
