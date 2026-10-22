# Ledger y plan de cuentas

Libro contable de doble partida, multi-moneda y append-only. Código: `src/ledger/`; esquema: migraciones 001 y 004.

## Reglas

- Montos `bigint` en unidades mínimas. Signo: **débito `+`, crédito `−`**.
- **Cada asiento cuadra a cero por moneda** y tiene al menos 2 partidas. Las conversiones pasan por las cuentas puente `platform:fx_position:<MON>`.
- Partidas y asientos son inmutables; un error se corrige con un asiento de reverso (`kind = 'reversal'`, `reverses_entry_id`). Hoy no hay flujo de la app que genere reversos.
- El saldo vive en `ledger.account_balances` y solo lo mueve el trigger de partidas. No existe un saldo editable.
- Una cuenta no puede quedar del lado contrario a su naturaleza (p. ej. un comercio con saldo deudor), salvo `allow_negative` (solo `fx_position`).

La app valida el cuadre antes de insertar (`assertBalanced`, `ledger.types.ts`) y la BD lo vuelve a exigir al COMMIT.

## Plan de cuentas (`chart-of-accounts.ts`)

Las cuentas se crean solas al primer uso a partir del código (`LedgerService.resolveAccounts` + `accountSpec`). Un código no reconocido lanza error.

| Código | Tipo | Para qué |
|---|---|---|
| `platform:rail_clearing:<riel>:<MON>` | activo | Lo que el banco/riel nos debe por cobros aprobados |
| `platform:cash:<MON>` | activo | Bancos y tesorería (VES nacional, USD Panamá, wallet USDT) |
| `platform:fee_revenue:<MON>` | ingreso | Comisión (MDR) |
| `platform:fx_spread_revenue:<MON>` | ingreso | Spread cambiario al convertir liquidaciones |
| `platform:tax_payable:iva:<MON>` | pasivo | IVA sobre la comisión |
| `platform:tax_payable:igtf:<MON>` | pasivo | IGTF 3 % de pagos en divisas en efectivo |
| `platform:fx_position:<MON>` | patrimonio, puede ser negativo | Posición cambiaria y aportes de capital |
| `merchant:<id>:pending:<MON>` | pasivo | Cobrado, aún no recibido del riel |
| `merchant:<id>:available:<MON>` | pasivo | Recibido, disponible para liquidar |

Los segmentos (riel, impuesto, comercio) deben cumplir `^[a-z0-9_]+$` (insensible a mayúsculas).

## Tipos de asiento (`kind`)

| `kind` | Quién lo genera | Llave de idempotencia |
|---|---|---|
| `payment_capture` | `PaymentIntentsService.applyRailResult` al pasar a `succeeded` | `capture:<pi_id>` |
| `rail_funds_received` | `SettlementsService.recordRailFunds` | `funds:<riel>:<batch_id>` |
| `merchant_payout` | `SettlementsService.runCutoff` | `payout:<stb_id>:<comercio>:<moneda>` |
| `capital_contribution` | `POST /internal/treasury/contributions` | `treasury:<reference>` |
| `refund`, `fee_adjustment`, `reversal` | Permitidos por el esquema; **sin flujo todavía** | — |

`LedgerService.post` es idempotente: si la llave ya existe devuelve el asiento original con `created: false` y no inserta partidas.

## Plantillas (`entry-templates.ts`)

Funciones puras que devuelven partidas ya cuadradas. Ejemplo de las pruebas (100 USD por Pago Móvil C2P a BCV 36,5):

**Captura** (`paymentCaptureEntry`)
```
Dr platform:rail_clearing:ves_c2p:VES   3.650,00
Cr merchant:<id>:pending:VES           −3.584,38   neto
Cr platform:fee_revenue:VES               −56,57   1,5 % + 0,05 USD
Cr platform:tax_payable:iva:VES            −9,05   16 % de la comisión
(Cr platform:tax_payable:igtf:USD  solo en efectivo)
```

**Fondos recibidos** (`railFundsReceivedEntry`): `Dr cash / Cr rail_clearing` por el bruto del lote y, por comercio, `Dr pending / Cr available` por su neto.

**Liquidación** (`merchantPayoutEntry`). Por ley siempre en bolívares (migración 010): lo cobrado en VES sale sin
conversión, lo cobrado en USD se convierte a VES a la tasa BCV exacta sin spread (#19) y lo cobrado en USDT se
convierte con spread de 1,2 %:
```
Cobrado en VES:   Dr available:VES / Cr cash:VES
Cobrado en USD:   Dr available:USD (saldo) / Cr fx_position:USD (saldo)
                  Dr fx_position:VES (convertido a BCV) / Cr cash:VES
Cobrado en USDT:  Dr available:USDT (saldo)
                  Cr fx_spread_revenue:USDT (spread)
                  Cr fx_position:USDT (saldo − spread)
                  Dr fx_position:VES (convertido) / Cr cash:VES
```
Las líneas en cero se descartan (`nonZeroLines`), así que una conversión sin spread no deja línea en `fx_spread_revenue`.
La plantilla sigue aceptando varias porciones (`allocateByBps`, el céntimo de redondeo va a la última), pero la base
solo admite una regla en VES al 100 %.

**Aporte de capital** (`InternalController.contribute`): `Dr cash:<MON> / Cr fx_position:<MON>`. Sirve, por ejemplo, para registrar los bolívares con que la tesorería paga lo cobrado en divisas (si no, `cash:VES` quedaría negativa y la BD rechaza con `P0003`).

## Concurrencia

- Las partidas de un asiento se insertan ordenadas por `account_id`: dos asientos concurrentes bloquean saldos en el mismo orden y no hacen deadlock entre sí.
- `withTransaction` reintenta hasta 3 veces ante `40001` (serialización) y `40P01` (deadlock).

## Auditoría

```sql
SELECT * FROM ledger.balance_drift;   -- vacío: saldos materializados = suma de partidas
SELECT * FROM ledger.trial_balance;   -- total 0 en cada moneda
```

`LedgerService.balance(code)` devuelve el saldo "natural": positivo es lo que la cuenta tiene según su naturaleza (para pasivos invierte el signo).
