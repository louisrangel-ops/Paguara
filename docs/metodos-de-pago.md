# Rieles y métodos de pago

Código: `src/payment-intents/payment-methods.ts`, `pricing.ts`, `rails/`.

## Métodos

Cada método define su riel, la moneda en que se cobra y su precio de plataforma (`PAYMENT_METHODS`). Un comercio
puede tener MDR y fijo negociados, y mínimo y máximo por pago, en `merchants.capabilities`; además cada método se
enciende o apaga por comercio ([modulos-por-comercio.md](modulos-por-comercio.md)). Nombres para el pagador en `METHOD_NAMES`.

| Método (`payment_method_type`) | Riel | Moneda de cobro | MDR | Fijo (USD) | IVA s/comisión | IGTF | TTL cotización |
|---|---|---|---|---|---|---|---|
| `pago_movil_c2p` | `ves_c2p` | VES | 1,50 % | 0,05 | 16 % | — | 5 min |
| `pago_movil_p2p` | `ves_p2p` | VES | 1,50 % | 0,05 | 16 % | — | 15 min |
| `debito_inmediato` | `ves_debito_inm` | VES | 1,50 % | 0,05 | 16 % | — | 5 min |
| `card_national` | `ves_card_switch` | VES | 3,80 % | — | 16 % | — | 5 min |
| `card_international` | `offshore_card` | USD | 4,90 % | 0,40 | — | — | 15 min |
| `zelle` | `zelle` | USD | 2,50 % | 0,25 | — | — | 30 min |
| `banesco_panama` | `banesco_panama` | USD | 2,50 % | 0,25 | — | — | 15 min |
| `usdt_trc20` | `usdt_trc20` | USDT | 1,20 % | 0,10 | — | — | 30 min |
| `usdt_polygon` | `usdt_polygon` | USDT | 1,20 % | 0,10 | — | — | 30 min |
| `cash` | `cash_network` | USD | 2,00 % | 0,25 | — | 3 % | 24 h |

`GET /api/public/methods` publica los precios de plataforma (en bps) para el sitio. El checkout recibe en
`payment_methods` solo los métodos que ese pago acepta, con los precios del comercio.

## Desglose (`computeBreakdown`)

Sobre el precio ya convertido a la moneda del cobro:

```
comisión = precio × MDR + fijo (convertido)
IVA      = comisión × feeTaxBps
IGTF     = precio × igtfBps          (solo efectivo; lo paga el pagador ENCIMA del precio)
neto     = precio − comisión − IVA   (lo que recibe el comercio)
charge   = precio + IGTF = comisión + IVA + neto + IGTF
```

Si el neto queda ≤ 0 → 400 `amount_too_small`. La BD verifica `charge = fee + tax + net + igtf` (`CHECK breakdown_adds_up`).

Ejemplo efectivo: precio 50,00 USD → el pagador entrega 51,50; el IGTF (1,50) queda en `platform:tax_payable:igtf:USD`.

## Interfaz de riel (`rails/rail-adapter.ts`)

```ts
interface RailAdapter { readonly rail: string; charge(req: RailChargeRequest): Promise<RailResult> }
```

`RailChargeRequest`: `paymentIntentId`, `attemptKey` (idempotencia hacia el banco, cambia en cada intento), `method`,
`currency`, `amount`, `details`. `RailResult`: `succeeded {reference}`, `pending {reference}`,
`requires_action {reference?, nextAction}` o `failed {code, message, reference?}`.

Códigos de rechazo: `insufficient_funds`, `do_not_honor`, `invalid_c2p_token`, `invalid_account`, `bank_unavailable`,
`action_expired`, `card_declined`, `processing_error`.

Los resultados asíncronos (webhook del banco, match de Pago Móvil P2P, confirmación on-chain, conciliación Zelle)
entran por `POST /internal/payment_intents/:id/rail_result {source, result}`.

## Riel sandbox (`rails/sandbox.rail.ts`)

**Hoy es el único riel**: `buildRails` (`src/app.module.ts`) registra un `SandboxRail` por cada riel. Con `LIVEMODE=true`
la API no arranca mientras quede un riel de prueba, para no cobrar "en vivo" contra el sandbox.
Resultados deterministas:

| Entrada | Resultado |
|---|---|
| `details.phone` termina en `0002` | `failed` `insufficient_funds` |
| `details.phone` termina en `0003` | `failed` `invalid_c2p_token` |
| `pago_movil_p2p` | `requires_action` `pago_movil_transfer` (banco, teléfono, RIF, monto, pista de referencia) |
| `zelle` | `requires_action` `zelle_transfer` |
| `banesco_panama` | `requires_action` `bank_transfer` (banco, cuenta, tipo, titular, concepto) |
| `usdt_trc20` / `usdt_polygon` | `requires_action` `crypto_transfer` (red y dirección de prueba) |
| `cash` | `requires_action` `cash_voucher` |
| `card_international` con `details.token = "tok_3ds"` | `requires_action` `three_d_secure` |
| Cualquier otro caso | `succeeded` |

Referencia: `sbx_<attemptKey>`.

## ISO 8583 (base de desarrollo)

Código: `rails/iso8583/codec.ts` y `rails/iso8583/simulator.ts`. Plan y requisitos del adquirente en
[iso8583-acquirer-integration.md](iso8583-acquirer-integration.md). **No es un riel**: no implementa `RailAdapter`, no
abre sockets, no está registrado en `buildRails` y `card_national` sigue en el sandbox.

- `encodeIso`/`decodeIso`: MTI de 4 dígitos, bitmap primario (y secundario si hay campos > 64), campos ASCII fijos y
  LLVAR según `TEST_PROFILE` (DE 2, 3, 4, 7, 11, 12, 13, 14, 18, 22, 25, 32, 37, 38, 39, 41, 42, 49). Rechaza campos fuera
  del perfil, largos o caracteres inválidos, campos numéricos con letras, mensajes truncados y bytes sobrantes.
- `Iso8583AcquirerSimulator`: emisor en memoria con perfil configurable (`SIMULATOR_PROFILE`: moneda 840, terminal
  `ECOM0001`). Responde `0100`→`0110` (aprobado `00` con autorización, rechazo con `declineCode`), `0400`→`0410` y
  `0420`→`0430` (reverso; `25` si no encuentra la original). Un `0100` repetido con el mismo STAN/RRN no crea otra
  transacción: responde según el estado actual del diario (`00` si sigue aprobada, `94` si ya se reversó). Si cambia
  DE 3, 4, 41, 42 o 49 da error; los demás campos no se comparan. `timeoutStan` simula un timeout de resultado desconocido
  (`SimulatedTimeout`). `reconcile()` resume aprobados, rechazados, reversados y el neto aprobado.
- Pruebas: `test/unit/iso8583-codec.test.ts` y `test/unit/iso8583-simulator.test.ts`.

## Pendiente

Conectores reales que implementen `RailAdapter`: C2P y débito inmediato por banco, switch de tarjetas nacionales
(ISO 8583), tarjetas internacionales, Banesco Panamá, Zelle, listeners TRON y Polygon, red de efectivo; y el
reconciliador de intents que quedaron en `processing`.
