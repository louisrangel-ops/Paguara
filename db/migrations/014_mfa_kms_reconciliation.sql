-- =====================================================================
-- 012 · DOBLE FACTOR, SECRETOS DE LOS BANCOS EN EL KMS Y CONCILIACIÓN DIARIA
--
-- 1. Doble factor (TOTP + códigos de respaldo) para los usuarios del panel
--    del comercio (opcional) y los operadores del panel interno (obligatorio).
--    Los operadores entran con su token opk_ + código y reciben una sesión
--    corta: el token solo ya no abre /internal.
-- 2. Llaves, claves y certificados de los bancos guardados cifrados por sobre
--    con el KMS. La base nunca los tiene en claro (CHECK del formato).
-- 3. Conciliación diaria: extractos del banco, cruce contra los cobros del
--    ledger, diferencias y alertas.
-- =====================================================================

-- 1 · Doble factor -----------------------------------------------------
CREATE SCHEMA IF NOT EXISTS security;

-- Una semilla TOTP por persona; confirmed_at NULL = inscripción a medias (todavía no protege)
CREATE TABLE security.mfa_factors (
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'operator')),
  principal_id   text NOT NULL,
  secret_sealed  text NOT NULL,                       -- semilla cifrada con el KMS
  confirmed_at   timestamptz,
  last_used_step bigint,                              -- último paso TOTP aceptado: un código no sirve dos veces
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_type, principal_id)
);

-- Códigos de respaldo de un solo uso; solo su SHA-256
CREATE TABLE security.mfa_recovery_codes (
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'operator')),
  principal_id   text NOT NULL,
  code_hash      text NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_type, principal_id, code_hash)
);

-- Quién activó, quitó o reinició un doble factor, y por qué (append-only)
CREATE TABLE security.mfa_audit (
  id             bigserial PRIMARY KEY,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'operator')),
  principal_id   text NOT NULL,
  action         text NOT NULL CHECK (action IN ('enrolled', 'disabled', 'reset', 'recovery_code_used', 'recovery_codes_regenerated')),
  actor          text NOT NULL,
  reason         text CHECK (length(reason) <= 300),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mfa_audit_immutable BEFORE UPDATE OR DELETE ON security.mfa_audit
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();

-- Sesión del panel interno: nace solo después del doble factor y dura horas, no días
CREATE TABLE platform.operator_sessions (
  token_hash  text PRIMARY KEY,                       -- SHA-256 del token ops_
  operator_id text NOT NULL REFERENCES platform.operators(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  ip          text
);
CREATE INDEX operator_sessions_operator_idx ON platform.operator_sessions (operator_id) WHERE revoked_at IS NULL;

-- 2 · Secretos de los rieles ------------------------------------------
-- Cada cambio crea una versión nueva; la anterior queda retirada (no se borra)
CREATE TABLE platform.rail_credentials (
  id          text PRIMARY KEY,                       -- 'rcred_...'
  rail        text NOT NULL CHECK (rail ~ '^[a-z0-9_]{2,40}$'),
  name        text NOT NULL CHECK (name ~ '^[a-z0-9_]{2,40}$'),
  kind        text NOT NULL CHECK (kind IN ('api_key', 'password', 'certificate', 'private_key', 'pkcs12')),
  version     int  NOT NULL CHECK (version >= 1),
  sealed      text NOT NULL CHECK (sealed LIKE 'env:v1:%'),   -- nunca en claro
  fingerprint text NOT NULL,                          -- SHA-256 del valor: se compara sin descifrar
  expires_at  timestamptz,                            -- vencimiento del certificado, si aplica
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz,
  UNIQUE (rail, name, version)
);
CREATE UNIQUE INDEX rail_credentials_active_idx ON platform.rail_credentials (rail, name) WHERE retired_at IS NULL;

-- 3 · Conciliación -----------------------------------------------------
CREATE SCHEMA IF NOT EXISTS reconciliation;

-- Un extracto: archivo del banco o consulta a su API, de un riel, moneda y día
CREATE TABLE reconciliation.statements (
  id             text PRIMARY KEY,                    -- 'bst_...'
  rail           text NOT NULL,
  currency       text NOT NULL REFERENCES ledger.currencies(code),
  statement_date date NOT NULL,
  source         text NOT NULL CHECK (source IN ('file', 'api', 'sandbox')),
  content_sha256 text NOT NULL,
  movement_count int  NOT NULL DEFAULT 0,
  imported_by    text NOT NULL,
  imported_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rail, currency, statement_date, content_sha256)
);

-- Movimientos del banco. Un movimiento repetido en otro extracto (archivo corregido) no se duplica;
-- uno que el extracto corregido ya no trae queda reemplazado (superseded_by) y no se concilia.
CREATE TABLE reconciliation.movements (
  id           bigserial PRIMARY KEY,
  statement_id text NOT NULL REFERENCES reconciliation.statements(id),
  superseded_by text REFERENCES reconciliation.statements(id),
  rail         text NOT NULL,
  currency     text NOT NULL REFERENCES ledger.currencies(code),
  value_date   date NOT NULL,
  amount       bigint NOT NULL CHECK (amount <> 0),   -- unidades mínimas; crédito > 0, débito < 0
  reference    text NOT NULL CHECK (length(reference) BETWEEN 1 AND 80),
  description  text CHECK (length(description) <= 300),
  UNIQUE (rail, currency, value_date, reference, amount)
);
CREATE INDEX movements_lookup_idx ON reconciliation.movements (rail, currency, value_date);

CREATE TABLE reconciliation.runs (
  id            text PRIMARY KEY,                     -- 'rec_...'
  rail          text NOT NULL,
  currency      text NOT NULL REFERENCES ledger.currencies(code),
  run_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'clean', 'discrepancies', 'failed')),
  ledger_count  int, bank_count int, matched_count int,
  ledger_total  bigint, bank_total bigint, matched_total bigint,
  released_entry_id uuid REFERENCES ledger.journal_entries(id),   -- fondos liberados a los comercios por esta corrida
  error         text,
  triggered_by  text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX runs_recent_idx ON reconciliation.runs (rail, currency, run_date DESC, started_at DESC);

-- Un cobro y un movimiento se cruzan una sola vez
CREATE TABLE reconciliation.matches (
  payment_intent_id text PRIMARY KEY REFERENCES payments.payment_intents(id),
  movement_id       bigint NOT NULL UNIQUE REFERENCES reconciliation.movements(id),
  run_id            text NOT NULL REFERENCES reconciliation.runs(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER matches_immutable BEFORE UPDATE OR DELETE ON reconciliation.matches
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();

CREATE TABLE reconciliation.discrepancies (
  id                text PRIMARY KEY,                 -- 'dsc_...'
  rail              text NOT NULL,
  currency          text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('missing_in_bank', 'missing_in_ledger', 'amount_mismatch', 'statement_missing')),
  item_key          text NOT NULL,                    -- id del cobro, del movimiento o el día sin extracto
  payment_intent_id text REFERENCES payments.payment_intents(id),
  movement_id       bigint REFERENCES reconciliation.movements(id),
  expected_amount   bigint,
  bank_amount       bigint,
  detail            text NOT NULL,
  first_run_id      text NOT NULL REFERENCES reconciliation.runs(id),
  last_run_id       text NOT NULL REFERENCES reconciliation.runs(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       text,
  resolution        text CHECK (length(resolution) <= 500),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);
-- Una misma diferencia abierta se actualiza en cada corrida, no se repite
CREATE UNIQUE INDEX discrepancies_open_idx ON reconciliation.discrepancies (rail, currency, kind, item_key) WHERE resolved_at IS NULL;

-- Alertas para operaciones (panel interno y ALERT_WEBHOOK_URL)
CREATE TABLE platform.alerts (
  id              text PRIMARY KEY,                   -- 'alr_...'
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  kind            text NOT NULL,
  title           text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',
  dedupe_key      text NOT NULL,
  occurrences     int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  delivery_error  text,
  acknowledged_at timestamptz,
  acknowledged_by text
);
CREATE UNIQUE INDEX alerts_open_idx ON platform.alerts (dedupe_key) WHERE acknowledged_at IS NULL;
