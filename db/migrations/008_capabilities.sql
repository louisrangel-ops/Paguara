-- =====================================================================
-- 008 · INTERRUPTORES POR COMERCIO: MÉTODOS DE PAGO Y MÓDULOS
--
-- Dos capas. La plataforma decide qué existe y a quién se le habilita
-- (platform.capabilities + platform_status por comercio); el comercio, dentro
-- de eso, enciende o apaga lo que quiere ofrecer (merchant_enabled).
-- La regla que combina ambas vive en merchants.capability_state(), así el
-- checkout, la API, el panel y el outbox de webhooks responden lo mismo.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE platform.capabilities (
  key             text PRIMARY KEY CHECK (key ~ '^[a-z0-9_]+$'),  -- 'pago_movil_c2p', 'payment_links'
  kind            text NOT NULL CHECK (kind IN ('method', 'module')),
  -- Interruptor de emergencia: apagado, nadie lo puede usar (riel caído, banco sin convenio)
  global_enabled  boolean NOT NULL DEFAULT true,
  -- Se le habilita solo a cada comercio nuevo; si no, el comercio lo pide y se revisa
  default_for_new boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform.capabilities (key, kind) VALUES
  ('pago_movil_c2p', 'method'), ('pago_movil_p2p', 'method'), ('debito_inmediato', 'method'),
  ('card_national', 'method'), ('card_international', 'method'), ('zelle', 'method'),
  ('banesco_panama', 'method'), ('usdt_trc20', 'method'), ('usdt_polygon', 'method'), ('cash', 'method'),
  ('payment_links', 'module'), ('webhooks', 'module');

CREATE TABLE merchants.capabilities (
  merchant_id      text NOT NULL REFERENCES merchants.merchants(id),
  key              text NOT NULL REFERENCES platform.capabilities(key),
  platform_status  text NOT NULL DEFAULT 'allowed' CHECK (platform_status IN ('allowed', 'pending_review', 'blocked')),
  merchant_enabled boolean NOT NULL DEFAULT true,
  -- Precio y límites negociados (NULL = los de la plataforma). Montos en unidades
  -- mínimas de la moneda de cobro del método (VES para Pago Móvil, USDT para USDT...).
  fee_bps          integer CHECK (fee_bps IS NULL OR fee_bps BETWEEN 0 AND 10000),
  fee_fixed_usd    bigint CHECK (fee_fixed_usd IS NULL OR fee_fixed_usd >= 0),
  min_amount       bigint CHECK (min_amount IS NULL OR min_amount > 0),
  max_amount       bigint CHECK (max_amount IS NULL OR max_amount > 0),
  updated_by       text NOT NULL,                  -- 'platform:<quién>', 'user:<id>', 'api_key'
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, key),
  CHECK (min_amount IS NULL OR max_amount IS NULL OR min_amount <= max_amount)
);

-- Quién cambió qué y cuándo. Append-only, como el ledger.
CREATE TABLE merchants.capability_changes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id text REFERENCES merchants.merchants(id),          -- NULL = cambio global de plataforma
  key         text NOT NULL REFERENCES platform.capabilities(key),
  actor       text NOT NULL,
  before      jsonb,
  after       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX capability_changes_merchant_idx ON merchants.capability_changes (merchant_id, created_at DESC);
CREATE TRIGGER capability_changes_immutable BEFORE UPDATE OR DELETE ON merchants.capability_changes
  FOR EACH ROW EXECUTE FUNCTION ledger.tg_immutable();

/**
 * Estado efectivo de una capacidad para un comercio:
 *   unavailable    la plataforma la apagó para todos
 *   not_granted    no se le ha habilitado a este comercio (puede pedirla)
 *   pending_review la pidió y está en revisión
 *   blocked        la plataforma se la bloqueó a este comercio
 *   disabled       el comercio la apagó
 *   active         se puede usar
 */
CREATE FUNCTION merchants.capability_state(p_merchant text, p_key text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN pc.key IS NULL OR NOT pc.global_enabled THEN 'unavailable'
    WHEN mc.merchant_id IS NULL THEN 'not_granted'
    WHEN mc.platform_status = 'blocked' THEN 'blocked'
    WHEN mc.platform_status = 'pending_review' THEN 'pending_review'
    WHEN NOT mc.merchant_enabled THEN 'disabled'
    ELSE 'active'
  END
  FROM (SELECT 1) one
  LEFT JOIN platform.capabilities pc ON pc.key = p_key
  LEFT JOIN merchants.capabilities mc ON mc.merchant_id = p_merchant AND mc.key = p_key
$$;

-- Cada comercio nuevo (registro, panel interno o seed) nace con los defaults de plataforma
CREATE FUNCTION merchants.tg_grant_default_capabilities() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO merchants.capabilities (merchant_id, key, updated_by)
  SELECT NEW.id, key, 'platform:default' FROM platform.capabilities WHERE default_for_new;
  RETURN NEW;
END $$;
CREATE TRIGGER merchants_default_capabilities AFTER INSERT ON merchants.merchants
  FOR EACH ROW EXECUTE FUNCTION merchants.tg_grant_default_capabilities();

-- Los comercios que ya existen siguen viendo exactamente lo mismo que antes
INSERT INTO merchants.capabilities (merchant_id, key, updated_by)
SELECT m.id, pc.key, 'platform:migration_008' FROM merchants.merchants m CROSS JOIN platform.capabilities pc;

-- Lista de métodos por pago y por link (NULL = todos los activos del comercio)
ALTER TABLE payments.payment_intents ADD COLUMN payment_method_types text[]
  CHECK (payment_method_types IS NULL OR cardinality(payment_method_types) > 0);
ALTER TABLE payments.payment_links ADD COLUMN payment_method_types text[]
  CHECK (payment_method_types IS NULL OR cardinality(payment_method_types) > 0);
