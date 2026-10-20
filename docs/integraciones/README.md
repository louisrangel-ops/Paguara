# Integración con tiendas en línea

Cómo se conecta Paguara a las plataformas de comercio electrónico y en qué orden conviene hacerlo. Lo que ya
existe en el repo está marcado; lo demás es plan.

## Qué ofrece la API para una tienda

Todas las integraciones usan el mismo patrón, el del **checkout alojado** (como Stripe Checkout):

1. El servidor de la tienda crea un pago con su llave secreta: `POST /v1/payment_intents` con el monto, la moneda,
   `metadata` con el id del pedido y `return_url` ([api.md](../api.md)).
2. La tienda redirige al pagador a `GET /checkout?pi=…&cs=…&pk=…`. Allí elige Pago Móvil, débito inmediato,
   tarjeta, Zelle, USDT o efectivo; Paguara cotiza con tasa congelada y cobra.
3. Al terminar, el checkout lo devuelve a `return_url` con `payment_intent` y `redirect_status`
   (`succeeded` o `canceled`) en la URL.
4. Paguara avisa con un webhook firmado (`payment_intent.succeeded`, etc.; [webhooks.md](../webhooks.md)).

La tienda **nunca** marca un pedido como pagado por el regreso del navegador ni por el cuerpo del webhook: en los
dos casos consulta `GET /v1/payment_intents/:id` con su llave secreta y compara monto, moneda y entorno.
Los datos de tarjeta y la clave de Pago Móvil quedan en el checkout de Paguara, no en la tienda.

Sin programar, cualquier comercio (Instagram, WhatsApp, una tienda sin plugin) puede usar **links de pago**
(`/pay/:slug`) desde el panel, pero un link no sabe a qué pedido corresponde: el comercio concilia a mano.

## Plataformas y cómo aceptan una pasarela externa

| Plataforma | Cómo se integra una pasarela | Aprobación de la plataforma | Estado |
|---|---|---|---|
| **WooCommerce** (WordPress) | Plugin PHP que extiende `WC_Payment_Gateway`; `process_payment()` devuelve la URL a la que redirigir. Para el checkout de bloques, además un `AbstractPaymentMethodType` y un script con `registerPaymentMethod`. | Ninguna: el comercio instala el .zip. Publicarlo en wordpress.org es opcional. | **Hecho (borrador)**: [woocommerce.md](woocommerce.md) |
| **Shopify** | App de pagos con extensión *offsite* (redirección a la página del proveedor y regreso a Shopify). | Hay que ser **Payments Partner** aprobado, la configuración de la extensión la revisa Shopify y hay acuerdo de reparto de ingresos. | Pendiente |
| **Wix** | *Payment Service Provider Service Plugin* (antes SPI): la app implementa los métodos que Wix llama, incluido el flujo de página alojada. | App pública revisada por Wix; un comercio puede usar un plugin propio en su sitio con Velo. | Pendiente |
| **Tiendanube** | App de *Payment Provider* en su tienda de apps (checkout transparente o redirección). | Partner aprobado. Presencia limitada en Venezuela. | Pendiente |
| **PrestaShop / Magento (Adobe Commerce)** | Módulo `PaymentModule` en PrestaShop; módulo de pago en Magento. | Ninguna para instalar a mano. | Pendiente, baja demanda esperada (**supuesto**) |
| **Tiendas a la medida** | La API directa: mismo patrón de los pasos 1–4. | — | Disponible ([api.md](../api.md)) |

## Orden recomendado

1. **WooCommerce.** No depende de ninguna aprobación, la mayoría de las tiendas pequeñas venezolanas que cobran
   en bolívares usan WordPress (**supuesto**: no hay cifras públicas de cuota por país; las guías locales nombran a
   WooCommerce y Shopify como las más usadas) y ya hay competencia local con plugins de Pago Móvil, como Pabilo
   en wordpress.org. Es el que está en este PR.
2. **Links de pago en el panel**, ya hechos: cubren a quien vende por redes y no tiene tienda.
3. **SDK de PHP y de Node** extraídos del cliente del plugin (la hoja de ruta, función 10). Ayudan a tiendas a la
   medida y a las demás integraciones.
4. **Shopify.** Es la otra plataforma grande, pero el bloqueo no es técnico: hace falta que Shopify apruebe a Paguara
   como Payments Partner y la extensión, con reparto de ingresos. Conviene pedirlo cuando Paguara tenga la licencia
   del BCV o el banco aliado (ver la hoja de ruta, fase 1), porque la solicitud describe a la empresa de pagos. Mientras tanto, una tienda Shopify puede usar links de pago como
   “pago manual”.
5. **Wix**, después **Tiendanube**, PrestaShop y Magento, según lo que pidan los comercios.

## Lo que falta en la API para que las integraciones queden completas

- **Reembolsos**: no hay endpoint (el asiento `refund` existe). Sin eso el plugin no puede devolver dinero desde la tienda.
- **Dominio público fijo** de la API y del sandbox (`api.paguara…`, `sandbox.paguara…`): el plugin pide las URLs en
  su configuración porque todavía no existen.
- **Rieles reales**: con `LIVEMODE=true` hoy no hay rieles de bancos conectados ([seguridad.md](../seguridad.md)).

## Fuentes

- WooCommerce, Payment Gateway API: https://developer.woocommerce.com/docs/features/payments/payment-gateway-api/
- Shopify, payments apps y extensión offsite: https://shopify.dev/docs/apps/build/payments y https://shopify.dev/docs/apps/build/payments/offsite/use-the-cli
- Wix, Payment Service Provider Service Plugin: https://dev.wix.com/docs/rest/business-management/payments/service-plugins/payment-service-provider-service-plugin/introduction
- Plataformas en Venezuela (blog comercial, no un estudio de mercado): https://www.andreybusiness.com/venezuela/blog/woocommerce-vs-tiendanube-vs-shopify-dropshipping-2026
- Plugin local de Pago Móvil para WooCommerce: https://es-mx.wordpress.org/plugins/pabilo-payment-gateway-for-woocommerce/
