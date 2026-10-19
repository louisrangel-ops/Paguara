-- =====================================================================
-- 009 · MÓDULOS DE LIQUIDACIÓN EN DIVISAS
--
-- Convertir la liquidación de un comercio a USDT o a USD (cuenta en Panamá
-- o EE. UU.) pasa a ser un módulo que la plataforma puede negar o bloquear.
-- Liquidar en la misma moneda cobrada, o convertir a bolívares, no lo requiere.
-- =====================================================================
INSERT INTO platform.capabilities (key, kind) VALUES ('settlement_usdt', 'module'), ('settlement_usd', 'module');

-- Los comercios existentes siguen liquidando como antes
INSERT INTO merchants.capabilities (merchant_id, key, updated_by)
SELECT m.id, k.key, 'platform:migration_009'
  FROM merchants.merchants m CROSS JOIN (VALUES ('settlement_usdt'), ('settlement_usd')) AS k(key);

-- Bandeja de solicitudes del panel interno
CREATE INDEX capabilities_pending_idx ON merchants.capabilities (updated_at) WHERE platform_status = 'pending_review';
