<?php
/**
 * Plugin Name:          Paguara para WooCommerce
 * Plugin URI:           https://github.com/louisrangel-ops/Paguara/tree/main/integraciones/woocommerce
 * Description:          Cobra en bolívares y divisas con Paguara: Pago Móvil, débito inmediato, tarjetas, Zelle y USDT en un solo checkout.
 * Version:              0.1.0
 * Requires at least:    6.4
 * Requires PHP:         7.4
 * Requires Plugins:     woocommerce
 * WC requires at least: 8.0
 * WC tested up to:      10.2
 * Author:               Paguara
 * License:              GPL-2.0-or-later
 * Text Domain:          paguara-woocommerce
 */

defined( 'ABSPATH' ) || exit;

define( 'PAGUARA_WC_FILE', __FILE__ );
define( 'PAGUARA_WC_VERSION', '0.1.0' );

require_once __DIR__ . '/includes/class-paguara-amount.php';
require_once __DIR__ . '/includes/class-paguara-signature.php';
require_once __DIR__ . '/includes/class-paguara-client.php';
require_once __DIR__ . '/includes/class-paguara-payment-flow.php';

// Compatible con los pedidos en tablas propias (HPOS) y con el checkout de bloques.
add_action(
	'before_woocommerce_init',
	function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', PAGUARA_WC_FILE, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', PAGUARA_WC_FILE, true );
		}
	}
);

add_action(
	'plugins_loaded',
	function () {
		if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
			return;
		}
		require_once __DIR__ . '/includes/class-wc-gateway-paguara.php';
		add_filter(
			'woocommerce_payment_gateways',
			function ( $gateways ) {
				$gateways[] = 'WC_Gateway_Paguara';
				return $gateways;
			}
		);
	}
);

add_action(
	'woocommerce_blocks_loaded',
	function () {
		if ( ! class_exists( \Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType::class ) ) {
			return;
		}
		require_once __DIR__ . '/includes/class-paguara-blocks-support.php';
		add_action(
			'woocommerce_blocks_payment_method_type_registration',
			function ( $registry ) {
				$registry->register( new Paguara_Blocks_Support() );
			}
		);
	}
);
