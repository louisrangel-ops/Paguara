-- =====================================================================
-- 010 · LIQUIDACIÓN SOLO EN BOLÍVARES, OPERADORES Y DOBLE APROBACIÓN
--
-- 1. Por ley, a los comercios se les paga en bolívares. Lo cobrado en USD o
--    USDT se convierte a VES en el corte. Se retiran los módulos
--    settlement_usdt y settlement_usd (migración 009).
-- 2. Cada persona del panel interno tiene su propio token (platform.operators):
--    la auditoría dice quién fue y la aprobación de pagos puede exigir personas distintas.
-- 3. Ninguna liquidación se paga sin las aprobaciones que pide: sus
--    instrucciones nacen retenidas (`on_hold`) y la base no las libera antes.
-- 4. Los métodos de pago se habilitan solo por contrato: ninguno se da solo a
--    un comercio nuevo y habilitarlo guarda la referencia del contrato.
-- =====================================================================

-- 1 · Solo bolívares ---------------------------------------------------
-- Donde había reparto, la cuenta en bolívares se queda con el 100 %. Quien no
-- tenía cuenta en bolívares para esa moneda queda sin regla y el corte lo
-- salta (`no_settlement_rule`) hasta que la registre: el saldo no se pierde.
UPDATE merchants.settlement_rules SET bps = 10000 WHERE target_currency = 'VES';
DELETE FROM merchants.settlement_rules WHERE target_currency <> 'VES';
ALTER TABLE merchants.settlement_rules
  ADD CONSTRAINT settlement_rules_ves_only CHECK (target_currency = 'VES' AND bps = 10000);

-- Las instrucciones viejas se conservan; toda instrucción nueva es en bolívares
ALTER TABLE settlements.payout_instructions
  ADD CONSTRAINT payout_instructions_ves_only CHECK (currency = 'VES') NOT VALID;

-- Los módulos retirados no se borran (la auditoría append-only los referencia):
-- quedan apagados para todos y fuera de los listados
ALTER TABLE platform.capabilities ADD COLUMN retired_at timestamptz;
UPDATE platform.capabilities SET global_enabled = false, default_for_new = false, retired_at = now(), updated_at = now()
 WHERE key IN ('settlement_usdt', 'settlement_usd');
DELETE FROM merchants.capabilities WHERE key IN ('settlement_usdt', 'settlement_usd');
ALTER TABLE platform.capabilities
  ADD CONSTRAINT capabilities_retired_off CHECK (retired_at IS NULL OR NOT (global_enabled OR default_for_new));

-- 2 · Operadores -------------------------------------------------------
-- master: KYC, métodos por contrato, precios, interruptores y alta de operadores.
-- operator: conciliación, tasas y aprobación de liquidaciones.
CREATE TABLE platform.operators (
  id          text PRIMARY KEY,                         -- 'op_...'
  name        text NOT NULL UNIQUE CHECK (length(name) BETWEEN 2 AND 60),
  role        text NOT NULL CHECK (role IN ('master', 'operator')),
  token_hash  text NOT NULL UNIQUE,                     -- SHA-256 del token; el token en claro se muestra una vez
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

-- 3 · Aprobación de liquidaciones -------------------------------------
-- Las liquidaciones anteriores a esta migración ya estaban liberadas
ALTER TABLE settlements.payouts
  ADD COLUMN status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending_approval', 'approved')),
  ADD COLUMN approvals_required smallint NOT NULL DEFAULT 1 CHECK (approvals_required >= 1),
  ADD COLUMN approved_at timestamptz;
ALTER TABLE settlements.payouts
  ALTER COLUMN status SET DEFAULT 'pending_approval',
  ALTER COLUMN approvals_required SET DEFAULT 2;

ALTER TABLE settlements.payout_instructions DROP CONSTRAINT payout_instructions_status_check;
ALTER TABLE settlements.payout_instructions
  ADD CONSTRAINT payout_instructions_status_check CHECK (status IN ('on_hold', 'pending', 'sent', 'confirmed', 'failed')),
  ALTER COLUMN status SET DEFAULT 'on_hold';

CREATE TABLE settlements.payout_approvals (
  payout_id   text NOT NULL REFERENCES settlements.payouts(id),
  operator_id text NOT NULL REFERENCES platform.operators(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (payout_id, operator_id)                  -- una persona aprueba una sola vez
);
CREATE TRIGGER payout_approvals_immutable BEFORE UPDATE OR DELETE ON settlements.payout_approvals
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();

-- Una liquidación solo pasa a aprobada con suficientes personas distintas, y no vuelve atrás
CREATE FUNCTION settlements.tg_payout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  IF OLD.status = 'approved' AND NEW.status <> 'approved' THEN
    RAISE EXCEPTION 'settlements: la liquidación % ya está aprobada', OLD.id USING ERRCODE = 'P0020';
  END IF;
  IF NEW.approvals_required < OLD.approvals_required THEN
    RAISE EXCEPTION 'settlements: no se pueden bajar las aprobaciones de %', OLD.id USING ERRCODE = 'P0020';
  END IF;
  IF OLD.status = 'pending_approval' AND NEW.status = 'approved' THEN
    SELECT count(*) INTO n FROM settlements.payout_approvals WHERE payout_id = NEW.id;
    IF n < NEW.approvals_required THEN
      RAISE EXCEPTION 'settlements: % tiene % de % aprobaciones', NEW.id, n, NEW.approvals_required USING ERRCODE = 'P0020';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payouts_guard BEFORE UPDATE ON settlements.payouts
  FOR EACH ROW EXECUTE FUNCTION settlements.tg_payout_guard();

-- Tesorería solo ve instrucciones liberadas: on_hold → pending exige la liquidación aprobada
CREATE FUNCTION settlements.tg_instruction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'on_hold' AND (TG_OP = 'INSERT' OR OLD.status = 'on_hold') THEN
    IF NOT EXISTS (SELECT 1 FROM settlements.payouts WHERE id = NEW.payout_id AND status = 'approved') THEN
      RAISE EXCEPTION 'settlements: la liquidación % no está aprobada', NEW.payout_id USING ERRCODE = 'P0020';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'on_hold' AND OLD.status <> 'on_hold' THEN
    RAISE EXCEPTION 'settlements: una instrucción liberada no vuelve a retenerse' USING ERRCODE = 'P0020';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_instructions_guard BEFORE INSERT OR UPDATE ON settlements.payout_instructions
  FOR EACH ROW EXECUTE FUNCTION settlements.tg_instruction_guard();

CREATE INDEX payouts_pending_approval_idx ON settlements.payouts (created_at) WHERE status = 'pending_approval';

-- 4 · Métodos por contrato ---------------------------------------------
UPDATE platform.capabilities SET default_for_new = false, updated_at = now() WHERE kind = 'method';
ALTER TABLE platform.capabilities
  ADD CONSTRAINT capabilities_methods_by_contract CHECK (kind <> 'method' OR NOT default_for_new);
-- Contrato con el que se habilitó (los métodos ya habilitados antes de esta migración no lo tienen)
ALTER TABLE merchants.capabilities ADD COLUMN contract_ref text CHECK (contract_ref IS NULL OR length(contract_ref) BETWEEN 3 AND 120);
