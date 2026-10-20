-- 015 · TASA OFICIAL BCV POR FECHA EFECTIVA
-- Toda conversion USD/VES usa la tasa oficial vigente publicada por el BCV.
ALTER TABLE fx.rates ADD COLUMN effective_date date;

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
