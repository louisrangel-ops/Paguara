# Conciliación bancaria diaria y alertas

Cada mañana se compara lo que dice el banco (extracto) con lo que dice el ledger (cobros capturados), por riel y moneda.
Detecta un pago marcado como cobrado que nunca llegó, créditos que no son de ningún cobro y montos distintos, y avisa.
Código en `src/reconciliation/` y `src/alerts/`; tablas en el esquema `reconciliation` (migración 012).

## Flujo

1. **Extracto**. Cada riel con fuente automática (`StatementSource`) lo trae solo; los demás se importan como archivo
   (`POST /internal/reconciliation/statements` o *Subir un extracto* en `/admin`). Se guarda en
   `reconciliation.statements` (riel, moneda, día, origen, SHA-256 del contenido) y sus movimientos en
   `reconciliation.movements` (monto en unidades mínimas, crédito > 0). El mismo archivo dos veces no duplica nada y
   un movimiento repetido en un archivo corregido tampoco (único por riel, moneda, fecha valor, referencia y monto).
2. **Cruce** (`ReconciliationService.run`). Toma los cobros con asiento de captura del riel y moneda cuyo día de cobro
   (hora de Caracas) cae entre `fecha − RECON_LOOKBACK_DAYS` y `fecha`, y los créditos del banco de ese rango, que
   todavía no se hayan cruzado. Cruza por `rail_reference` = referencia del banco **y** monto igual al bruto cobrado.
   Cada cobro y cada movimiento se cruzan una sola vez (`reconciliation.matches`, append-only). Un lock por riel y
   moneda evita dos corridas a la vez.
3. **Liberación**. Los cobros cruzados que aún no tienen fondos recibidos pasan de *por recibir* a *disponible* para el
   comercio (`SettlementsService.recordRailFunds`, asiento `rail_funds_received` con `funds:<riel>:<rec_id>`). Solo
   entonces entran en un corte de liquidación. Lo que no cuadró no se libera.
4. **Diferencias** (`reconciliation.discrepancies`):

   | Tipo | Cuándo | Gravedad |
   |---|---|---|
   | `missing_in_bank` | Cobro sin crédito en el banco (pasados `RECON_GRACE_DAYS` días) | crítica |
   | `amount_mismatch` | Misma referencia, monto distinto | crítica |
   | `missing_in_ledger` | Crédito del banco sin cobro con esa referencia | atención |
   | `statement_missing` | No se importó el extracto de ese día | atención |

   Una diferencia abierta se actualiza en cada corrida (no se repite: índice único abierto por riel, moneda, tipo y
   elemento). Se cierra sola cuando luego cuadra (llegó el crédito, llegó el extracto); las demás las cierra una
   persona con una nota de 5 a 500 caracteres (`resolved_by`, `resolution`).
5. **Alertas** (`AlertsService`, `platform.alerts`). Una corrida con diferencias dispara una alerta por riel, moneda y
   día (crítica si falta dinero o hay montos distintos); una que falla, `reconciliation_failed`. Se envían a
   `ALERT_WEBHOOK_URL` (cuerpo `{text, alert}`, sirve para Slack, Teams, Discord y Google Chat) y se ven en `/admin` →
   *Alertas* hasta que alguien las marca vistas. Una alerta abierta con la misma llave no se reenvía: suma
   `occurrences`. Si el envío falla queda `delivery_error`.

Repetir una corrida es seguro: lo cruzado no se vuelve a cruzar ni a liberar, y una corrida que falló a mitad deja que
la siguiente libere lo pendiente.

## Job diario

`POST /internal/reconciliation/daily {date?}` (por defecto ayer en Caracas) recorre todos los pares riel/moneda de los
métodos de pago (`reconcilablePairs`): trae el extracto si hay fuente automática, concilia y además alerta los
certificados de bancos que vencen en menos de 30 días. Responde el estado de cada riel.

`npm run reconcile [AAAA-MM-DD]` (`scripts/reconcile.ts`, en la imagen `node dist/scripts/reconcile.js`) lo llama con el
token de sistema; sale con código 1 si algún riel no cuadró o falló. En producción se programa una vez al día (p. ej.
06:00 hora de Caracas, 10:00 UTC) en el cron del hosting, contra el puerto interno.

En desarrollo y sandbox, `dev-jobs` concilia ayer y hoy cada `RECON_EVERY_SECONDS` contra el **banco simulado**
(`SandboxStatementSource`): su extracto son los cobros que el riel de prueba aprobó, por el monto exacto. Así el flujo
corre de punta a punta y los fondos se liberan para el corte. Con `LIVEMODE=true` no hay fuente simulada.

## Formato del extracto

CSV con encabezado, separado por coma o punto y coma (`src/reconciliation/statement-parser.ts`):

```
fecha;referencia;monto;descripcion
20/10/2026;000123456;3.650,00;Pago Móvil 0414…
20/10/2026;COM-77;-5,00;Comisión
```

- Columnas reconocidas: `fecha`/`fecha_valor`, `referencia`/`ref`, `monto`/`importe`, `descripcion`/`concepto` (opcional).
- Fecha `AAAA-MM-DD` o `DD/MM/AAAA`. Monto con coma o punto decimal; si hay ambos, el último es el decimal
  (`3.650,00` y `3,650.00` son lo mismo). Negativo o entre paréntesis = débito. Más decimales que la moneda → error
  (`1.234` en bolívares es ambiguo y se rechaza).
- También se acepta JSON: `movements: [{value_date, amount (entero en unidades mínimas), reference, description?}]`.
- Cada banco exporta su propio formato: se convierte a este o se agrega su parser.

## Rutas (`/internal`, ver [api.md](api.md#api-interna))

| Método | Ruta | Quién | Qué hace |
|---|---|---|---|
| POST | `/internal/reconciliation/statements` | S, O | Importa un extracto (`{rail, currency, statement_date, csv}` o `movements`) |
| POST | `/internal/reconciliation/runs` | S, O | Concilia `{rail, currency, date}` y devuelve la corrida con sus diferencias |
| POST | `/internal/reconciliation/daily` | S, O | Job diario de todos los rieles |
| GET | `/internal/reconciliation/runs?limit=` | O | Últimas corridas |
| GET | `/internal/reconciliation/runs/:id` | O | Una corrida con sus diferencias |
| GET | `/internal/reconciliation/discrepancies` | O | Diferencias abiertas |
| POST | `/internal/reconciliation/discrepancies/:id/resolve` | O | Cierra una con `{resolution}` |
| GET | `/internal/alerts` | O | Alertas abiertas, críticas primero |
| POST | `/internal/alerts/:id/acknowledge` | O | Marca vista |

## Pendiente

- Fuentes automáticas reales (API de movimientos de cada banco, SFTP del archivo de cierre): hoy solo existe la del
  sandbox; en producción el extracto se sube como archivo hasta conectar cada banco.
- Conciliar también el saldo de cierre del extracto contra `platform:cash:<MON>` y las salidas (liquidaciones pagadas).
- Alertas por correo o SMS además del webhook.
