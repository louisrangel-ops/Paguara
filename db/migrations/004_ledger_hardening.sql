-- =====================================================================
-- 004 · SALDO CORRIDO POR PARTIDA Y SALDOS NO EDITABLES
--
-- De la guía de arquitectura se adopta `running_balance` por partida (sirve
-- para estados de cuenta sin recalcular). NO se adopta un `current_balance`
-- editable en la cuenta: el saldo vive en ledger.account_balances y solo el
-- trigger de postings puede moverlo. Un UPDATE directo se rechaza.
-- =====================================================================
ALTER TABLE ledger.postings ADD COLUMN balance_after bigint;

DROP TRIGGER posting_apply ON ledger.postings;

-- Pasa a BEFORE INSERT para poder escribir NEW.balance_after en la misma fila
CREATE OR REPLACE FUNCTION ledger.tg_posting_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acc ledger.accounts%ROWTYPE;
  new_balance bigint;
BEGIN
  SELECT * INTO acc FROM ledger.accounts WHERE id = NEW.account_id;
  IF acc.currency <> NEW.currency THEN
    RAISE EXCEPTION 'ledger: posting en % sobre cuenta % (%)', NEW.currency, acc.code, acc.currency
      USING ERRCODE = 'P0002';
  END IF;

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

  NEW.balance_after := new_balance;
  RETURN NEW;
END $$;
CREATE TRIGGER posting_apply BEFORE INSERT ON ledger.postings
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_posting_apply();

ALTER TABLE ledger.postings ALTER COLUMN balance_after SET NOT NULL;

-- Solo los triggers del ledger (profundidad > 1) pueden tocar saldos
CREATE FUNCTION ledger.tg_balances_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'ledger: los saldos solo cambian registrando un asiento (% directo prohibido)', TG_OP
      USING ERRCODE = 'P0005';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER balances_guard BEFORE UPDATE OR DELETE ON ledger.account_balances
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_balances_guard();
CREATE TRIGGER balances_no_truncate BEFORE TRUNCATE ON ledger.account_balances
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.tg_immutable();

-- La liquidación ahora puede cobrar spread cambiario como ingreso explícito
ALTER TABLE ledger.journal_entries DROP CONSTRAINT journal_entries_kind_check;
ALTER TABLE ledger.journal_entries ADD CONSTRAINT journal_entries_kind_check CHECK (kind IN (
  'payment_capture', 'rail_funds_received', 'merchant_payout',
  'refund', 'fee_adjustment', 'capital_contribution', 'reversal'));
