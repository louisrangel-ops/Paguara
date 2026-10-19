# Liquidaciones

Código: `src/settlements/settlements.service.ts`, `src/ledger/entry-templates.ts`. Esquema: migración 006 y
`merchants.settlement_rules` (005).

El dinero de un cobro pasa por tres cuentas del comercio: **cobrado** (asiento de captura, en
`merchant:<id>:pending`), **recibido** (el riel nos pagó, pasa a `merchant:<id>:available`) y **liquidado** (corte de lote,
sale a `platform:cash` y queda una instrucción de pago para tesorería).

## 1. Conciliación de fondos del riel

`POST /internal/rail_batches {batch_id, rail, currency, payment_intent_ids}` → `recordRailFunds`.

- Bloquea los intents y exige que estén cobrados (`payment_not_captured`), sean de ese riel y moneda (`batch_mismatch`) y no estén ya conciliados (`funds_already_received`).
- Registra un asiento `rail_funds_received` (llave `funds:<riel>:<batch_id>`) y marca `funds_received_entry_id` en cada intent.
- El intent sigue en `succeeded`.

## 2. Reglas de split por comercio

Por moneda origen, una lista de destinos `{target_currency, bps, destination}` que suma 10.000 bps (100 %).
Ejemplo: VES → 60 % VES a cuenta bancaria + 40 % USDT a wallet TRC-20.

- API interna: `POST /internal/merchants/:id/settlement_rules`.
- Dashboard: `PUT /api/dashboard/settlement_rules/:source` (1 a 3 destinos, monedas VES/USD/USDT sin repetir, `destination` ≤ 1000 caracteres en JSON).
- Reemplaza todas las reglas de esa moneda origen en una transacción.
- Convertir a USDT o a USD exige el módulo `settlement_usdt` o `settlement_usd` activo (403 `feature_disabled`).
  Liquidar en la misma moneda o convertir a VES no exige módulo (`settlementModuleFor`).

## 3. Corte de lote

`POST /internal/settlement_batches {batch_code, source_currency, min_amount?, spread_bps?}` → `runCutoff`.
Lo debe disparar un cron por moneda y hora de corte (**pendiente**: hoy no hay cron de cortes).

1. Crea o reutiliza el lote por `batch_code` (p. ej. `2026-10-16-VES-1800`).
2. Agrupa por comercio los intents `succeeded` con fondos recibidos en esa moneda.
3. Comercios con neto menor que `min_amount` → `skipped: below_minimum`. Sin regla → `no_settlement_rule`. Si una
   regla convierte a una divisa cuyo módulo no está activo → `settlement_module_disabled`: sus pagos siguen en
   `succeeded` para el próximo corte.
4. Cada comercio va en **su propia transacción**: un error en uno no detiene al resto (queda en `skipped` con su código).
5. Por comercio: vuelve a bloquear los intents, congela una cotización de 60 s por cada porción convertida
   (fuente por defecto del par), registra el asiento `merchant_payout`, crea `settlements.payouts` y una
   `payout_instructions` por porción (`status = pending`), pasa los intents a `settled` y emite `payout.created`.
6. Cierra el lote (`status = closed`).

Repetir el mismo `batch_code` no liquida dos veces: los intents ya están `settled` y la llave del asiento es única.

## Spread cambiario

`spread_bps` del pedido o `FX_PAYOUT_SPREAD_BPS` (120 = 1,2 %). Se aplica **solo a la porción convertida**,
nunca al cobrar. Se registra como ingreso visible (`platform:fx_spread_revenue`), no escondido en la tasa: la tasa
aplicada es la de mercado y la instrucción guarda `fx_rate` y `fx_spread_bps`.

## Fondeo de tesorería

Para pagar porciones en otra moneda (p. ej. USDT), `platform:cash:USDT` necesita saldo; si no, la BD rechaza el asiento
(`P0003` → el comercio queda en `skipped`). Se fondea con `POST /internal/treasury/contributions {currency, amount, reference}`.

## Pendiente

- Dispersores que lean `payout_instructions` pendientes: archivo ACH por banco (formato de ancho fijo según banco), envío de USDT, transferencia Panamá; y que actualicen `status`/`external_ref`.
- Cron de cortes automáticos por moneda y hora.
- Reserva (rolling reserve), reembolsos y contracargos.
