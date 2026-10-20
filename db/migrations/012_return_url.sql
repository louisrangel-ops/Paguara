-- =====================================================================
-- 012 · URL DE RETORNO DEL CHECKOUT
--
-- A dónde vuelve el pagador después de pagar en el checkout alojado.
-- La usan las tiendas en línea (WooCommerce y las que vengan) para
-- regresar al pagador a su pedido. No es secreta: el checkout la muestra.
-- La validación de forma (https, sin usuario ni clave) vive en la API;
-- aquí solo se limita el largo.
-- =====================================================================

ALTER TABLE payments.payment_intents
  ADD COLUMN return_url text CHECK (return_url IS NULL OR length(return_url) <= 2048);
