-- =====================================================================
-- 006 · CORTE DE LOTE DE LIQUIDACIÓN
--
-- Un corte agrupa, por comercio, los intents cobrados cuyos fondos ya llegaron
-- del riel; aplica la regla de split del comercio, registra el asiento y deja
-- instrucciones de pago para los dispersores (archivo ACH por banco, envío de
-- USDT, transferencia Panamá). Las instrucciones son lo que ejecuta tesorería.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS settlements;

CREATE TABLE settlements.batches (
  id          text PRIMARY KEY,                 -- 'stb_...'
  batch_code  text NOT NULL UNIQUE,             -- '2026-10-16-VES-1800'
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

CREATE TABLE settlements.payouts (
  id               text PRIMARY KEY,            -- 'po_...'
  batch_id         text NOT NULL REFERENCES settlements.batches(id),
  merchant_id      text NOT NULL REFERENCES merchants.merchants(id),
  source_currency  text NOT NULL REFERENCES ledger.currencies(code),
  source_amount    bigint NOT NULL CHECK (source_amount > 0),
  ledger_entry_id  uuid NOT NULL REFERENCES ledger.journal_entries(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, merchant_id, source_currency)
);

CREATE TABLE settlements.payout_instructions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id       text NOT NULL REFERENCES settlements.payouts(id),
  currency        text NOT NULL REFERENCES ledger.currencies(code),
  amount          bigint NOT NULL CHECK (amount > 0),
  fx_rate         numeric(30, 12),
  fx_spread_bps   integer NOT NULL DEFAULT 0,
  destination     jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'confirmed', 'failed')),
  external_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payout_instructions_pending_idx ON settlements.payout_instructions (currency) WHERE status = 'pending';
