<?php
/**
 * Registro del método en el checkout de bloques de WooCommerce. El cobro sigue
 * pasando por WC_Gateway_Paguara::process_payment (redirección).
 */

defined( 'ABSPATH' ) || exit;

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

final class Paguara_Blocks_Support extends AbstractPaymentMethodType {

	protected $name = 'paguara';

	public function initialize() {
		$this->settings = get_option( 'woocommerce_paguara_settings', array() );
	}

	public function is_active() {
		$gateways = WC()->payment_gateways()->payment_gateways();
		return isset( $gateways['paguara'] ) && $gateways['paguara']->is_available();
	}

	public function get_payment_method_script_handles() {
		wp_register_script(
			'paguara-blocks',
			plugins_url( 'assets/js/paguara-blocks.js', PAGUARA_WC_FILE ),
			array( 'wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities' ),
			PAGUARA_WC_VERSION,
			true
		);
		return array( 'paguara-blocks' );
	}

	public function get_payment_method_data() {
		return array(
			'title'       => $this->get_setting( 'title' ),
			'description' => $this->get_setting( 'description' ),
			'supports'    => array( 'products' ),
		);
	}
}
