-- 013 · RBAC DEL PANEL INTERNO Y AUDITORIA DE CAMBIOS DE ROL
-- Conserva master/operator por compatibilidad y agrega roles funcionales.
ALTER TABLE platform.operators DROP CONSTRAINT IF EXISTS operators_role_check;
ALTER TABLE platform.operators
  ADD CONSTRAINT operators_role_check CHECK (
    role IN ('master','operator','compliance','operations','treasury','support','auditor')
  );

CREATE TABLE platform.operator_role_changes (
  id           bigserial PRIMARY KEY,
  operator_id  text NOT NULL REFERENCES platform.operators(id),
  old_role     text NOT NULL,
  new_role     text NOT NULL,
  changed_by   text NOT NULL REFERENCES platform.operators(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (old_role IN ('master','operator','compliance','operations','treasury','support','auditor')),
  CHECK (new_role IN ('master','operator','compliance','operations','treasury','support','auditor'))
);

CREATE INDEX operator_role_changes_operator_idx
  ON platform.operator_role_changes (operator_id, created_at DESC);

CREATE TRIGGER operator_role_changes_immutable
  BEFORE UPDATE OR DELETE ON platform.operator_role_changes
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();
