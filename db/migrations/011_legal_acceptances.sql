-- =====================================================================
-- 011 · ACEPTACIÓN DE LOS DOCUMENTOS LEGALES
--
-- Prueba de que cada persona aceptó los términos, el acuerdo de comercio,
-- la política de privacidad y la de uso aceptable, en qué versión, cuándo y
-- desde dónde. Es append-only: una versión nueva se acepta con otra fila,
-- nunca se reescribe la anterior.
-- =====================================================================

CREATE TABLE dashboard.legal_acceptances (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES dashboard.users(id),
  merchant_id text NOT NULL REFERENCES merchants.merchants(id),
  document    text NOT NULL CHECK (document IN ('terminos', 'comercios', 'privacidad', 'uso-aceptable')),
  version     text NOT NULL CHECK (version ~ '^\d{4}-\d{2}-\d{2}$'),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip          text,
  user_agent  text CHECK (length(user_agent) <= 400),
  UNIQUE (user_id, document, version)
);
CREATE INDEX legal_acceptances_merchant_idx ON dashboard.legal_acceptances (merchant_id);

CREATE TRIGGER legal_acceptances_immutable BEFORE UPDATE OR DELETE ON dashboard.legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();
CREATE TRIGGER legal_acceptances_no_truncate BEFORE TRUNCATE ON dashboard.legal_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.tg_immutable();
