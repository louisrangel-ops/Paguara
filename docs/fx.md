# Tasas de cambio (FX)

Código: `src/fx/fx.service.ts`, `src/fx/fx.math.ts`, `src/common/money.ts`. Esquema: migración 002.

## Conceptos

- **Tasa observada** (`fx.rates`): un valor leído de una fuente en un momento. Fuentes: `BCV`, `PARALLEL`,
  `BINANCE_P2P`, `EXCHANGE` (USD/USDT del exchange de la plataforma), `MANUAL`. Inmutable.
- **Cotización congelada** (`fx.quotes`, `fxq_…`): copia de una tasa con vencimiento. Lo que se muestra al pagador es
  exactamente lo que se cobra. Inmutable.
- Convención: 1 `base` = `rate` `quote`. `USD/VES 36.5` significa 1 USD = 36,50 Bs.

## Registrar una tasa

`POST /internal/fx/rates {base, quote, rate, source, observed_at?}` → `FxService.recordRate`. La tasa es un string
decimal (`"36.5"`) con hasta 12 decimales.

**Pendiente:** el job real que lea BCV, Binance P2P y el exchange. En desarrollo, `dev-jobs` carga tasas **fijas**
(`DEV_FX_RATES`) cada `FX_REFRESH_SECONDS` ([configuracion.md](configuracion.md)).

## Congelar una cotización

`FxService.freezeQuote(client, a, b, source, ttlSeconds)` toma la tasa más reciente de esa fuente para el par
**en cualquier dirección**, con antigüedad menor que `FX_MAX_RATE_AGE_SECONDS` (6 h por defecto). Si no hay,
lanza `RateUnavailableError` → 503 `fx_rate_unavailable`.

Fuente por defecto (`defaultRateSource`, `payment-methods.ts`):

| Par | Fuente |
|---|---|
| USDT/VES | `BINANCE_P2P` |
| USD/USDT | `EXCHANGE` |
| Cualquier otro (USD/VES…) | `BCV` |

En la API v1, `attach` acepta `fx_source` para elegir otra. **Decisión pendiente:** fuente por defecto configurable por comercio.

Dónde se congela:

| Momento | TTL | Código |
|---|---|---|
| `attach`, si la moneda del precio ≠ moneda del cobro | `quoteTtlSeconds` del método (5 min a 24 h) | `PaymentIntentsService.attachPaymentMethod` |
| Comisión fija en USD cuando la cotización del intent no sirve (p. ej. precio en VES cobrado en VES) | igual | `fixedFeeIn` |
| Cada porción convertida de una liquidación | 60 s | `SettlementsService.settleMerchant` |

Consecuencia: los métodos en VES con comisión fija necesitan una tasa `BCV` USD/VES reciente aunque el precio ya esté en VES.

## Aritmética exacta

- Tasas escaladas a 12 decimales como `bigint` (`parseRate`), igual que `numeric(30,12)`.
- `convert` multiplica; `convertWithQuote` divide cuando la cotización está en el sentido contrario, **sin invertir la tasa** (invertir 36,5 perdería precisión).
- Redondeo bancario (half-even) en `divRoundHalfEven`. Porcentajes en puntos básicos con `applyBps`.
- Ningún `float` en el camino del dinero.

## Decisiones

- La comisión fija en USDT se convierte con la tasa USD/USDT `EXCHANGE`, no 1:1. Sin tasa `EXCHANGE` reciente, los métodos USDT responden `fx_rate_unavailable`.
- El spread del 1,2 % solo se aplica al convertir liquidaciones, nunca al cobrar ([liquidaciones.md](liquidaciones.md)).
- Se rechazó guardar tasas en `NUMERIC(18,6)`: 6 decimales no alcanzan para USDT/VES invertido.
