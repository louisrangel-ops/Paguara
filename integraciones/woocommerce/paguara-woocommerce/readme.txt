=== Paguara para WooCommerce ===
Tags: pago movil, venezuela, bolivares, usdt, pasarela de pago
Requires at least: 6.4
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later

Cobra en bolívares y divisas con Paguara: Pago Móvil, débito inmediato, tarjetas, Zelle y USDT en un solo checkout.

== Description ==

Tu cliente elige Paguara al pagar y lo llevamos al checkout seguro de Paguara. Allí paga con el método que prefiera,
con la tasa congelada, y vuelve a tu tienda. El pedido se marca como pagado cuando Paguara lo confirma.

* Funciona con el checkout clásico y con el de bloques.
* Modo pruebas con el sandbox de Paguara: no se mueve dinero.
* Verifica la firma de cada webhook y consulta el pago con tu llave secreta antes de cambiar el pedido.

== Installation ==

1. Sube el .zip en Plugins → Añadir nuevo → Subir plugin y actívalo.
2. En WooCommerce → Ajustes → Pagos → Paguara pega la URL y las llaves de tu cuenta (Desarrolladores → Llaves API).
3. En el panel de Paguara crea un webhook con la URL que muestra el ajuste y pega su secreto whsec_.
4. Prueba un pedido en modo pruebas y luego cambia a producción.

== Changelog ==

= 0.1.0 =
* Primera versión: redirección al checkout, regreso a la tienda, webhooks firmados y modo pruebas.
