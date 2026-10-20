# Liquidaciones

Código: `src/settlements/settlements.service.ts`, `src/ledger/entry-templates.ts`. Esquema: migraciones 006 y 010 y
`merchants.settlement_rules` (005).

**Por ley, a los comercios se les paga en bolívares.** Lo cobrado en USD o USDT se convierte a VES en el corte. La
base de datos lo impone: `settlement_rules` solo acepta `target_currency = 'VES'` al 100 % y toda instrucción de pago
nueva es en VES (migración 010). Ninguna liquidación llega a tesorería sin la aprobación de personas distintas.

El dinero de un cobro pasa por tres cuentas del comercio: **cobrado** (asiento de captura, en
`merchant:<id>:pending`), **recibido** (el riel nos pagó, pasa a `merchant:<id>:available`) y **liquidado** (corte de lote,
sale a `platform:cash` y queda una instrucción de pago para tesorería).

## 1. Conciliación de fondos del riel

Lo hace sola la **conciliación diaria** ([conciliacion.md](conciliacion.md)): cada cobro que cuadra con el extracto del
banco por referencia y monto se libera con `recordRailFunds` (lote = id de la corrida `rec_…`); lo que no cuadra no se
libera y queda como diferencia. También se puede a mano:
`POST /internal/rail_batches {batch_id, rail, currency, payment_intent_ids}` → `recordRailFunds`.

- Bloquea los intents y exige que estén cobrados (`payment_not_captured`), sean de ese riel y moneda (`batch_mismatch`) y no estén ya conciliados (`funds_already_received`).
- Registra un asiento `rail_funds_received` (llave `funds:<riel>:<batch_id>`) y marca `funds_received_entry_id` en cada intent.
- El intent sigue en `succeeded`.

## 2. Cuenta de liquidación por moneda cobrada

Por moneda cobrada (VES, USD o USDT), una sola regla: `{target_currency: 'VES', bps: 10000, destination}`, la cuenta
en un banco nacional que recibe todo.

- API interna (solo el maestro): `POST /internal/merchants/:id/settlement_rules`.
- Dashboard: `PUT /api/dashboard/settlement_rules/:source` con una regla VES. Valida banco (4 dígitos), cuenta de
  20 dígitos que empieza por el código de ese banco y titular; guarda `{type: 'bank_ves', bank, account, holder}`.
- Otra moneda de destino o más de una regla → 400 `settlement_currency_invalid`; un porcentaje distinto de 100 % →
  400 `settlement_rules_invalid`.
- Hasta la migración 010 se podía repartir entre VES, USD y USDT con los módulos `settlement_usdt` y
  `settlement_usd`. La migración dejó la cuenta en bolívares al 100 % donde la había, borró las demás reglas (el
  comercio sin cuenta en Bs queda `no_settlement_rule` hasta registrarla) y retiró esos módulos.

## 3. Corte de lote

`POST /internal/settlement_batches {batch_code, source_currency, min_amount?, spread_bps?}` → `runCutoff`.
Lo debe disparar un cron por moneda y hora de corte (**pendiente**: hoy no hay cron de cortes).

1. Crea o reutiliza el lote por `batch_code` (p. ej. `2026-10-16-VES-1800`).
2. Agrupa por comercio los intents `succeeded` con fondos recibidos en esa moneda.
3. Comercios con neto menor que `min_amount` → `skipped: below_minimum`. Sin cuenta en bolívares para esa moneda →
   `no_settlement_rule`: sus pagos siguen en `succeeded` para el próximo corte.
4. Cada comercio va en **su propia transacción**: un error en uno no detiene al resto (queda en `skipped` con su código).
5. Por comercio: vuelve a bloquear los intents; si la moneda cobrada no es VES congela una cotización de 60 s a VES
   (fuente por defecto del par: BCV para USD, `BINANCE_P2P` para USDT); registra el asiento `merchant_payout`, crea
   `settlements.payouts` (`status = pending_approval`, `approvals_required = PAYOUT_APPROVALS_REQUIRED`) y su
   `payout_instructions` en VES **retenida** (`status = on_hold`), pasa los intents a `settled` y emite `payout.created`.
6. Cierra el lote (`status = closed`).

Repetir el mismo `batch_code` no liquida dos veces: los intents ya están `settled` y la llave del asiento es única.

## 4. Aprobación antes de pagar

Una instrucción `on_hold` no la ve tesorería. La liberan las aprobaciones de personas distintas del panel interno:

- `GET /internal/payouts/pending`: bandeja con comercio, lote, monto, cuenta y quién aprobó ya.
- `POST /internal/payouts/:id/approve`: con la sesión personal de un operador (`ops_…`, token `opk_` más doble factor), nunca con el de sistema
  (403 `insufficient_role`). Cada persona cuenta una vez (409 `already_approved_by_you`). Al llegar a
  `approvals_required`, la liquidación pasa a `approved` y sus instrucciones a `pending` (lista para el dispersor).
- La base lo impone con triggers (`P0020` → 409 `payout_not_approved`): una instrucción no sale de `on_hold` sin la
  liquidación aprobada, una liquidación no pasa a `approved` sin las aprobaciones contadas en
  `settlements.payout_approvals` (append-only), `approvals_required` no se puede bajar y lo liberado no vuelve atrás.
- `PAYOUT_APPROVALS_REQUIRED` vale 2 por defecto; con `LIVEMODE=true` la API no arranca con menos de 2.

Las liquidaciones creadas antes de la migración 010 quedaron como `approved`.

## Spread cambiario

`spread_bps` del pedido o `FX_PAYOUT_SPREAD_BPS` (120 = 1,2 %). Se aplica **solo a la porción convertida**,
nunca al cobrar. Se registra como ingreso visible (`platform:fx_spread_revenue`), no escondido en la tasa: la tasa
aplicada es la de mercado y la instrucción guarda `fx_rate` y `fx_spread_bps`.

## Fondeo de tesorería

Pagar en bolívares lo cobrado en USD o USDT sale de `platform:cash:VES`: la tesorería necesita bolívares antes del
corte (vendiendo las divisas recibidas). Si no alcanza, la BD rechaza el asiento (`P0003` → el comercio queda en
`skipped` y su saldo espera al próximo corte). Se registra con `POST /internal/treasury/contributions
{currency, amount, reference}` (solo el maestro).

## Pendiente

- Dispersor que lea `payout_instructions` en `pending` (ya aprobadas): archivo de pago por banco nacional (formato de ancho fijo según banco), y que actualice `status`/`external_ref`.
- Rechazar una liquidación aprobada por error: hoy no hay reverso; una liquidación dudosa se deja sin aprobar.
- Confirmar con asesoría legal la tasa para convertir USDT a bolívares (hoy `BINANCE_P2P`; la de USD es la BCV).
- Cron de cortes automáticos por moneda y hora.
- Reserva (rolling reserve), reembolsos y contracargos.
