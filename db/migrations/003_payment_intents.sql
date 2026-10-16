-- =====================================================================
-- 003 · PAYMENT INTENTS Y SU MÁQUINA DE ESTADOS
--
--   requires_payment_method ─attach─▶ requires_confirmation ─confirm─▶ processing ─▶ succeeded ─payout─▶ settled
--            ▲                                                       │   ▲
--            │                                                       ▼   │
--            └───────────── fallo del riel ◀──────────────── requires_action
--                                                            (OTP C2P, 3DS, transferir P2P/Zelle, enviar USDT)
--   cancel: desde requires_payment_method / requires_confirmation / requires_action
--
-- La BD repite las reglas de la aplicación (defensa en profundidad):
--   · solo transiciones de payments.allowed_transitions
--   · monto cobrado, moneda y tasa CONGELADOS desde que se confirma
--     (processing / requires_action / succeeded / settled)
--   · succeeded exige asiento de captura; settled exige asiento de liquidación
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS payments;

CREATE TYPE payments.pi_status AS ENUM (
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'succeeded',
  'settled',
  'canceled'
);

CREATE TABLE payments.allowed_transitions (
  from_status payments.pi_status NOT NULL,
  to_status   payments.pi_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO payments.allowed_transitions VALUES
  ('requires_payment_method', 'requires_confirmation'),
  ('requires_payment_method', 'canceled'),
  ('requires_confirmation',   'processing'),
  ('requires_confirmation',   'canceled'),
  ('requires_action',         'processing'),
  ('requires_action',         'requires_payment_method'),
  ('requires_action',         'canceled'),
  ('processing',              'requires_action'),
  ('processing',              'succeeded'),
  ('processing',              'requires_payment_method'),
  ('succeeded',               'settled');

CREATE TABLE payments.payment_intents (
  id                  text PRIMARY KEY,                       -- 'pi_...'
  merchant_id         text NOT NULL,
  -- Precio que fijó el comercio (moneda de presentación)
  amount              bigint NOT NULL CHECK (amount > 0),
  currency            text NOT NULL REFERENCES ledger.currencies(code),
  -- Lo que efectivamente se le cobra al pagador por el riel elegido
  payment_method_type text CHECK (payment_method_type IN (
                        'pago_movil_c2p', 'pago_movil_p2p', 'debito_inmediato',
                        'card_national', 'card_international', 'zelle',
                        'usdt_trc20', 'usdt_polygon', 'cash')),
  rail                text,
  charge_currency     text REFERENCES ledger.currencies(code),
  charge_amount       bigint CHECK (charge_amount > 0),
  -- Tasa congelada (NULL si charge_currency = currency)
  fx_quote_id         text REFERENCES fx.quotes(id),
  fx_rate             numeric(30, 12),
  fx_rate_source      text,
  fx_quote_expires_at timestamptz,
  -- Desglose en charge_currency
  fee_amount          bigint CHECK (fee_amount >= 0),
  tax_amount          bigint CHECK (tax_amount >= 0),
  net_amount          bigint CHECK (net_amount >= 0),
  -- IGTF 3 %: solo pagos en divisas en efectivo; lo paga el pagador encima del precio
  igtf_amount         bigint NOT NULL DEFAULT 0 CHECK (igtf_amount >= 0),
  status              payments.pi_status NOT NULL DEFAULT 'requires_payment_method',
  version             integer NOT NULL DEFAULT 0,
  next_action         jsonb,
  last_payment_error  jsonb,
  rail_reference      text,
  capture_entry_id    uuid REFERENCES ledger.journal_entries(id),
  funds_received_entry_id uuid REFERENCES ledger.journal_entries(id),  -- el banco/riel nos acreditó
  settlement_entry_id uuid REFERENCES ledger.journal_entries(id),
  cancellation_reason text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  processing_at       timestamptz,
  succeeded_at        timestamptz,
  settled_at          timestamptz,
  canceled_at         timestamptz,

  CONSTRAINT charge_ready_before_processing CHECK (
    status NOT IN ('requires_confirmation', 'requires_action', 'processing', 'succeeded', 'settled')
    OR (charge_amount IS NOT NULL AND charge_currency IS NOT NULL AND net_amount IS NOT NULL
        AND (charge_currency = currency OR (fx_rate IS NOT NULL AND fx_quote_id IS NOT NULL)))),
  CONSTRAINT breakdown_adds_up CHECK (
    charge_amount IS NULL OR charge_amount = fee_amount + tax_amount + net_amount + igtf_amount),
  CONSTRAINT capture_entry_on_success CHECK (
    status NOT IN ('succeeded', 'settled') OR capture_entry_id IS NOT NULL),
  CONSTRAINT funds_received_only_after_capture CHECK (
    funds_received_entry_id IS NULL OR capture_entry_id IS NOT NULL),
  CONSTRAINT settlement_entry_on_settled CHECK (
    status <> 'settled' OR (settlement_entry_id IS NOT NULL AND funds_received_entry_id IS NOT NULL))
);
CREATE INDEX payment_intents_merchant_idx ON payments.payment_intents (merchant_id, created_at DESC);
CREATE INDEX payment_intents_status_idx   ON payments.payment_intents (status) WHERE status IN ('processing', 'requires_action', 'succeeded');
CREATE UNIQUE INDEX payment_intents_rail_ref_idx ON payments.payment_intents (rail, rail_reference) WHERE rail_reference IS NOT NULL;

CREATE TABLE payments.payment_intent_transitions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_intent_id text NOT NULL REFERENCES payments.payment_intents(id),
  from_status       payments.pi_status,
  to_status         payments.pi_status NOT NULL,
  event             text NOT NULL,
  actor             text NOT NULL,
  details           jsonb NOT NULL DEFAULT '{}'::jsonb,
  ledger_entry_id   uuid REFERENCES ledger.journal_entries(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pi_transitions_pi_idx ON payments.payment_intent_transitions (payment_intent_id, id);
CREATE TRIGGER pi_transitions_immutable BEFORE UPDATE OR DELETE ON payments.payment_intent_transitions
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();

CREATE FUNCTION payments.tg_pi_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.merchant_id <> OLD.merchant_id
     OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'payments: id, comercio, monto y moneda de presentación son inmutables'
      USING ERRCODE = 'P0010';
  END IF;

  IF NEW.status <> OLD.status AND NOT EXISTS (
       SELECT 1 FROM payments.allowed_transitions
        WHERE from_status = OLD.status AND to_status = NEW.status) THEN
    RAISE EXCEPTION 'payments: transición % → % no permitida para %', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'P0011';
  END IF;

  -- Tasa y montos congelados mientras el dinero está en vuelo o ya cobrado
  IF OLD.status IN ('processing', 'requires_action', 'succeeded', 'settled')
     AND NEW.status IN ('processing', 'requires_action', 'succeeded', 'settled')
     AND (NEW.charge_amount   IS DISTINCT FROM OLD.charge_amount
       OR NEW.charge_currency IS DISTINCT FROM OLD.charge_currency
       OR NEW.fx_rate         IS DISTINCT FROM OLD.fx_rate
       OR NEW.fx_quote_id     IS DISTINCT FROM OLD.fx_quote_id
       OR NEW.fee_amount      IS DISTINCT FROM OLD.fee_amount
       OR NEW.tax_amount      IS DISTINCT FROM OLD.tax_amount
       OR NEW.net_amount      IS DISTINCT FROM OLD.net_amount
       OR NEW.igtf_amount     IS DISTINCT FROM OLD.igtf_amount
       OR NEW.rail            IS DISTINCT FROM OLD.rail
       OR NEW.payment_method_type IS DISTINCT FROM OLD.payment_method_type) THEN
    RAISE EXCEPTION 'payments: monto cobrado y tasa de % están congelados en estado %', OLD.id, OLD.status
      USING ERRCODE = 'P0012';
  END IF;

  IF OLD.capture_entry_id IS NOT NULL AND NEW.capture_entry_id IS DISTINCT FROM OLD.capture_entry_id
     OR OLD.funds_received_entry_id IS NOT NULL AND NEW.funds_received_entry_id IS DISTINCT FROM OLD.funds_received_entry_id
     OR OLD.settlement_entry_id IS NOT NULL AND NEW.settlement_entry_id IS DISTINCT FROM OLD.settlement_entry_id THEN
    RAISE EXCEPTION 'payments: los asientos contables vinculados a % no se reemplazan', OLD.id
      USING ERRCODE = 'P0012';
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER pi_guard BEFORE UPDATE ON payments.payment_intents
  FOR EACH ROW EXECUTE FUNCTION payments.tg_pi_guard();

CREATE TRIGGER pi_no_delete BEFORE DELETE ON payments.payment_intents
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();
