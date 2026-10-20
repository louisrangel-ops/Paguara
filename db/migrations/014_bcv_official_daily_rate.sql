-- 014 · TASA OFICIAL BCV POR FECHA EFECTIVA
-- Las conversiones USD/VES deben usar la tasa oficial del BCV vigente para
-- la fecha de Venezuela, no una tasa paralela ni una ventana de "últimas 6 h".
ALTER TABLE fx.rates ADD COLUMN effective_date date;

-- Histórico existente: para BCV asumimos como fecha efectiva la fecha Venezuela
-- en que se observó. Nuevas cargas BCV deben declarar effective_date.
UPDATE fx.rates
   SET effective_date = (observed_at AT TIME ZONE 'America/Caracas')::date
 WHERE source = 'BCV' AND effective_date IS NULL;

ALTER TABLE fx.rates
  ADD CONSTRAINT fx_bcv_effective_date_required
  CHECK (source <> 'BCV' OR effective_date IS NOT NULL);

CREATE UNIQUE INDEX fx_bcv_daily_pair_idx
  ON fx.rates (base_currency, quote_currency, source, effective_date)
  WHERE source = 'BCV';

CREATE INDEX rates_bcv_effective_lookup_idx
  ON fx.rates (base_currency, quote_currency, effective_date DESC)
  WHERE source = 'BCV';
