-- =====================================================================
-- 001 · LEDGER DE DOBLE PARTIDA MULTI-MONEDA (append-only)
--
-- Reglas que garantiza la base de datos (no solo la aplicación):
--   1. Montos en BIGINT de unidades mínimas (céntimos, micro-USDT). Nunca float.
--   2. Convención de signo: amount > 0 = DÉBITO, amount < 0 = CRÉDITO.
--   3. Cada asiento cuadra a cero POR MONEDA (VES con VES, USD con USD).
--      Las conversiones pasan por cuentas puente fx_position:<moneda>.
--   4. Postings y asientos son inmutables: UPDATE/DELETE/TRUNCATE prohibidos.
--      Un error se corrige con un asiento de reverso (reverses_entry_id).
--   5. Saldos materializados en account_balances, actualizados por trigger
--      en la misma transacción; una cuenta no puede quedar del lado contrario
--      a su naturaleza (p. ej. un comercio con saldo negativo) salvo
--      allow_negative.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS ledger;

CREATE TABLE ledger.currencies (
  code     text PRIMARY KEY CHECK (code ~ '^[A-Z]{3,5}$'),
  exponent smallint NOT NULL CHECK (exponent BETWEEN 0 AND 18),
  kind     text NOT NULL CHECK (kind IN ('fiat', 'crypto'))
);

INSERT INTO ledger.currencies (code, exponent, kind) VALUES
  ('VES', 2, 'fiat'),
  ('USD', 2, 'fiat'),
  ('EUR', 2, 'fiat'),
  ('USDT', 6, 'crypto');

CREATE TYPE ledger.account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

CREATE TABLE ledger.accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,          -- 'merchant:m_123:pending:VES'
  name           text NOT NULL,
  type           ledger.account_type NOT NULL,
  currency       text NOT NULL REFERENCES ledger.currencies(code),
  owner_type     text NOT NULL CHECK (owner_type IN ('platform', 'merchant')),
  owner_id       text,
  allow_negative boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_type = 'merchant') = (owner_id IS NOT NULL))
);
CREATE INDEX accounts_owner_idx ON ledger.accounts (owner_type, owner_id);

CREATE TABLE ledger.journal_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   text NOT NULL UNIQUE,
  kind              text NOT NULL CHECK (kind IN (
                      'payment_capture', 'rail_funds_received', 'merchant_payout',
                      'refund', 'fee_adjustment', 'reversal')),
  reference_type    text,
  reference_id      text,
  description       text,
  reverses_entry_id uuid UNIQUE REFERENCES ledger.journal_entries(id),
  effective_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((kind = 'reversal') = (reverses_entry_id IS NOT NULL))
);
CREATE INDEX journal_entries_ref_idx ON ledger.journal_entries (reference_type, reference_id);

CREATE TABLE ledger.postings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id   uuid NOT NULL REFERENCES ledger.journal_entries(id),
  account_id uuid NOT NULL REFERENCES ledger.accounts(id),
  currency   text NOT NULL REFERENCES ledger.currencies(code),
  amount     bigint NOT NULL CHECK (amount <> 0),
  fx_rate    numeric(30, 12),   -- informativo: tasa aplicada si la partida nace de una conversión
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX postings_account_idx ON ledger.postings (account_id, id);
CREATE INDEX postings_entry_idx   ON ledger.postings (entry_id);

CREATE TABLE ledger.account_balances (
  account_id      uuid PRIMARY KEY REFERENCES ledger.accounts(id),
  currency        text NOT NULL REFERENCES ledger.currencies(code),
  balance         bigint NOT NULL DEFAULT 0,   -- suma de amounts (débito +, crédito -)
  last_posting_id bigint,
  version         bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Toda cuenta nace con su fila de saldo en 0
-- ---------------------------------------------------------------------
CREATE FUNCTION ledger.tg_account_init_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ledger.account_balances (account_id, currency) VALUES (NEW.id, NEW.currency);
  RETURN NEW;
END $$;
CREATE TRIGGER account_init_balance AFTER INSERT ON ledger.accounts
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_account_init_balance();

-- La moneda y el tipo de una cuenta no cambian nunca
CREATE FUNCTION ledger.tg_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency <> OLD.currency OR NEW.type <> OLD.type OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'ledger: código, tipo y moneda de una cuenta son inmutables' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_guard BEFORE UPDATE ON ledger.accounts
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_account_guard();

-- ---------------------------------------------------------------------
-- Posting: moneda debe coincidir con la cuenta; actualiza saldo y valida signo
-- ---------------------------------------------------------------------
CREATE FUNCTION ledger.tg_posting_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acc ledger.accounts%ROWTYPE;
  new_balance bigint;
BEGIN
  SELECT * INTO acc FROM ledger.accounts WHERE id = NEW.account_id;
  IF acc.currency <> NEW.currency THEN
    RAISE EXCEPTION 'ledger: posting en % sobre cuenta % (%)', NEW.currency, acc.code, acc.currency
      USING ERRCODE = 'P0002';
  END IF;

  -- El UPDATE toma el lock de fila de la cuenta (equivalente a SELECT ... FOR UPDATE)
  UPDATE ledger.account_balances
     SET balance = balance + NEW.amount,
         last_posting_id = NEW.id,
         version = version + 1,
         updated_at = now()
   WHERE account_id = NEW.account_id
  RETURNING balance INTO new_balance;

  IF NOT acc.allow_negative THEN
    IF acc.type IN ('asset', 'expense') AND new_balance < 0 THEN
      RAISE EXCEPTION 'ledger: saldo insuficiente en % (saldo deudor quedaría %)', acc.code, new_balance
        USING ERRCODE = 'P0003';
    ELSIF acc.type IN ('liability', 'equity', 'revenue') AND new_balance > 0 THEN
      RAISE EXCEPTION 'ledger: saldo insuficiente en % (saldo acreedor quedaría %)', acc.code, -new_balance
        USING ERRCODE = 'P0003';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER posting_apply AFTER INSERT ON ledger.postings
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_posting_apply();

-- ---------------------------------------------------------------------
-- Cuadre: se verifica al COMMIT (deferred), cuando ya están todas las partidas
-- ---------------------------------------------------------------------
CREATE FUNCTION ledger.tg_entry_must_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry uuid;
  bad record;
  n int;
BEGIN
  IF TG_TABLE_NAME = 'postings' THEN entry := NEW.entry_id; ELSE entry := NEW.id; END IF;
  SELECT count(*) INTO n FROM ledger.postings WHERE entry_id = entry;
  IF n < 2 THEN
    RAISE EXCEPTION 'ledger: el asiento % tiene % partidas (mínimo 2)', entry, n USING ERRCODE = 'P0004';
  END IF;
  SELECT currency, sum(amount) AS total INTO bad
    FROM ledger.postings WHERE entry_id = entry
   GROUP BY currency HAVING sum(amount) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger: el asiento % no cuadra en % (descuadre %)', entry, bad.currency, bad.total
      USING ERRCODE = 'P0004';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entry_must_balance_on_posting
  AFTER INSERT ON ledger.postings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_entry_must_balance();
CREATE CONSTRAINT TRIGGER entry_must_balance_on_entry
  AFTER INSERT ON ledger.journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_entry_must_balance();

-- ---------------------------------------------------------------------
-- Inmutabilidad
-- ---------------------------------------------------------------------
CREATE FUNCTION ledger.tg_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger: % es append-only (% prohibido); usa un asiento de reverso', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0005';
END $$;
CREATE TRIGGER postings_immutable BEFORE UPDATE OR DELETE ON ledger.postings
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();
CREATE TRIGGER postings_no_truncate BEFORE TRUNCATE ON ledger.postings
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.tg_immutable();
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON ledger.journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON ledger.journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.tg_immutable();

-- ---------------------------------------------------------------------
-- Auditoría: saldos materializados vs. suma real de postings (debe estar vacía)
-- ---------------------------------------------------------------------
CREATE VIEW ledger.balance_drift AS
SELECT b.account_id, a.code, b.balance AS materialized, coalesce(s.total, 0) AS from_postings
  FROM ledger.account_balances b
  JOIN ledger.accounts a ON a.id = b.account_id
  LEFT JOIN (SELECT account_id, sum(amount) AS total FROM ledger.postings GROUP BY account_id) s
         ON s.account_id = b.account_id
 WHERE b.balance <> coalesce(s.total, 0);

-- Balance de comprobación por moneda (cada fila debe dar 0)
CREATE VIEW ledger.trial_balance AS
SELECT currency, sum(amount) AS total FROM ledger.postings GROUP BY currency;
