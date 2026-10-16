-- =====================================================================
-- 007 · DASHBOARD DEL COMERCIO: USUARIOS, SESIONES, WEBHOOKS Y LINKS DE PAGO
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS dashboard;
CREATE SCHEMA IF NOT EXISTS webhooks;

-- Datos de activación (KYC) que envía el comercio; la revisión la hace el panel interno
ALTER TABLE merchants.merchants
  ADD COLUMN kyc_data         jsonb,
  ADD COLUMN kyc_submitted_at timestamptz;

-- La llave publicable no es secreta (va en el navegador): se guarda en claro para mostrarla
-- en el dashboard y para armar los links de pago. Las secretas siguen solo como hash.
ALTER TABLE merchants.api_keys
  ADD COLUMN publishable_key text,
  ADD CONSTRAINT api_keys_publishable_plain_check CHECK (publishable_key IS NULL OR kind = 'publishable');

CREATE TABLE dashboard.users (
  id            text PRIMARY KEY,                                  -- 'usr_...'
  merchant_id   text NOT NULL REFERENCES merchants.merchants(id),
  email         text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name          text NOT NULL,
  password_hash text NOT NULL,                                     -- scrypt$N$r$p$salt$hash
  role          text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_email_idx ON dashboard.users (email);

-- Solo se guarda el SHA-256 del token de sesión: un volcado de la BD no permite entrar
CREATE TABLE dashboard.sessions (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES dashboard.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX sessions_user_idx ON dashboard.sessions (user_id);

-- ---------------------------------------------------------------------
-- Webhooks con outbox transaccional: el evento se inserta en la MISMA
-- transacción que cambia el pago, así nunca se avisa algo que no pasó ni se
-- pierde algo que sí pasó. Un worker entrega con reintentos.
-- ---------------------------------------------------------------------
CREATE TABLE webhooks.endpoints (
  id             text PRIMARY KEY,                                 -- 'we_...'
  merchant_id    text NOT NULL REFERENCES merchants.merchants(id),
  url            text NOT NULL CHECK (url ~ '^https?://'),
  secret         text NOT NULL,                                    -- 'whsec_...'; en producción, cifrado con KMS
  enabled_events text[] NOT NULL CHECK (cardinality(enabled_events) > 0),
  status         text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX endpoints_merchant_idx ON webhooks.endpoints (merchant_id);

CREATE TABLE webhooks.events (
  id          text PRIMARY KEY,                                    -- 'evt_...'
  merchant_id text NOT NULL REFERENCES merchants.merchants(id),
  type        text NOT NULL,
  object_id   text NOT NULL,
  livemode    boolean NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_merchant_idx ON webhooks.events (merchant_id, created_at DESC, id DESC);
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON webhooks.events
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();

CREATE TABLE webhooks.deliveries (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id         text NOT NULL REFERENCES webhooks.events(id),
  endpoint_id      text NOT NULL REFERENCES webhooks.endpoints(id),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_status_code integer,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, endpoint_id)
);
CREATE INDEX deliveries_due_idx ON webhooks.deliveries (next_attempt_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------
-- Links de pago: cada visita crea un PaymentIntent nuevo con el monto fijo
-- ---------------------------------------------------------------------
CREATE TABLE payments.payment_links (
  id          text PRIMARY KEY,                                    -- 'plink_...'
  merchant_id text NOT NULL REFERENCES merchants.merchants(id),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-zA-Z0-9]{12,40}$'),
  amount      bigint NOT NULL CHECK (amount > 0),
  currency    text NOT NULL REFERENCES ledger.currencies(code),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  livemode    boolean NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_links_merchant_idx ON payments.payment_links (merchant_id);

ALTER TABLE payments.payment_intents ADD COLUMN payment_link_id text REFERENCES payments.payment_links(id);
CREATE INDEX payment_intents_link_idx ON payments.payment_intents (payment_link_id) WHERE payment_link_id IS NOT NULL;
-- Listados del dashboard: por comercio, más recientes primero
CREATE INDEX payment_intents_merchant_created_idx ON payments.payment_intents (merchant_id, created_at DESC, id DESC);
