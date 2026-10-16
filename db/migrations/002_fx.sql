-- =====================================================================
-- 002 · TASAS DE CAMBIO Y COTIZACIONES CONGELADAS
--
-- fx.rates  : histórico de tasas observadas (BCV, paralelo, Binance P2P, USD/USDT del exchange...).
-- fx.quotes : la tasa CONGELADA que se le mostró al pagador. Inmutable.
--             Un PaymentIntent referencia una cotización; desde que entra en
--             'processing' ya no puede cambiarla (ver 003).
-- Convención: 1 unidad de base_currency = rate unidades de quote_currency.
--             USD→VES 36.50 significa 1 USD = 36,50 Bs.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS fx;

CREATE TABLE fx.rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency  text NOT NULL REFERENCES ledger.currencies(code),
  quote_currency text NOT NULL REFERENCES ledger.currencies(code),
  rate           numeric(30, 12) NOT NULL CHECK (rate > 0),
  source         text NOT NULL CHECK (source IN ('BCV', 'PARALLEL', 'BINANCE_P2P', 'EXCHANGE', 'MANUAL')),
  observed_at    timestamptz NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (base_currency <> quote_currency),
  UNIQUE (base_currency, quote_currency, source, observed_at)
);
CREATE INDEX rates_lookup_idx ON fx.rates (base_currency, quote_currency, source, observed_at DESC);

CREATE TABLE fx.quotes (
  id             text PRIMARY KEY,                 -- 'fxq_...'
  rate_id        uuid NOT NULL REFERENCES fx.rates(id),
  base_currency  text NOT NULL REFERENCES ledger.currencies(code),
  quote_currency text NOT NULL REFERENCES ledger.currencies(code),
  rate           numeric(30, 12) NOT NULL CHECK (rate > 0),   -- copia congelada
  source         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE TRIGGER quotes_immutable BEFORE UPDATE OR DELETE ON fx.quotes
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();
CREATE TRIGGER rates_immutable BEFORE UPDATE OR DELETE ON fx.rates
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();
