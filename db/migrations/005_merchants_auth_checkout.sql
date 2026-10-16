-- =====================================================================
-- 005 · COMERCIOS (KYC), API KEYS Y DATOS PARA EL CHECKOUT
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS merchants;

CREATE TABLE merchants.merchants (
  id             text PRIMARY KEY CHECK (id ~ '^[a-z0-9_]+$'),   -- 'acct_...' ; se usa en códigos de cuenta
  business_name  text NOT NULL,
  rif            text NOT NULL UNIQUE CHECK (rif ~ '^[JGVEP]-?[0-9]{8}-?[0-9]$'),
  status         text NOT NULL DEFAULT 'pending_kyc'
                   CHECK (status IN ('pending_kyc', 'active', 'restricted', 'closed')),
  webhook_url    text CHECK (webhook_url IS NULL OR webhook_url ~ '^https://'),
  -- Se necesita en claro para firmar con HMAC; en producción, cifrado con KMS.
  webhook_secret text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Llaves estilo Stripe. Solo se guarda el hash SHA-256; la llave en claro se
-- muestra una vez al crearla. sk_ = servidor del comercio, pk_ = navegador.
CREATE TABLE merchants.api_keys (
  id           text PRIMARY KEY,                   -- 'key_...'
  merchant_id  text NOT NULL REFERENCES merchants.merchants(id),
  kind         text NOT NULL CHECK (kind IN ('secret', 'publishable')),
  livemode     boolean NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,                      -- 'sk_live_4f2a…' para mostrar en el dashboard
  is_active    boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX api_keys_merchant_idx ON merchants.api_keys (merchant_id);

-- Regla de liquidación por comercio: "60 % en VES, 40 % en USDT"
CREATE TABLE merchants.settlement_rules (
  merchant_id     text NOT NULL REFERENCES merchants.merchants(id),
  source_currency text NOT NULL REFERENCES ledger.currencies(code),
  target_currency text NOT NULL REFERENCES ledger.currencies(code),
  bps             integer NOT NULL CHECK (bps > 0 AND bps <= 10000),
  destination     jsonb NOT NULL,                  -- cuenta bancaria VES, wallet TRC-20, cuenta Panamá...
  PRIMARY KEY (merchant_id, source_currency, target_currency)
);

-- Intents: dueño real, idempotencia durable, secreto del checkout y vencimiento
ALTER TABLE payments.payment_intents
  ADD CONSTRAINT payment_intents_merchant_fk FOREIGN KEY (merchant_id) REFERENCES merchants.merchants(id),
  ADD COLUMN livemode        boolean NOT NULL DEFAULT false,
  ADD COLUMN idempotency_key text,
  ADD COLUMN client_secret   text,
  ADD COLUMN customer        jsonb,      -- nombre, cédula/RIF, teléfono, email del pagador
  ADD COLUMN expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours';
CREATE UNIQUE INDEX payment_intents_idem_idx ON payments.payment_intents (merchant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payment_intents_client_secret_idx ON payments.payment_intents (client_secret);
CREATE INDEX payment_intents_expiry_idx ON payments.payment_intents (expires_at)
  WHERE status IN ('requires_payment_method', 'requires_confirmation', 'requires_action');

ALTER TABLE payments.payment_intents DROP CONSTRAINT payment_intents_payment_method_type_check;
ALTER TABLE payments.payment_intents ADD CONSTRAINT payment_intents_payment_method_type_check CHECK (payment_method_type IN (
  'pago_movil_c2p', 'pago_movil_p2p', 'debito_inmediato', 'card_national', 'card_international',
  'zelle', 'banesco_panama', 'usdt_trc20', 'usdt_polygon', 'cash'));
