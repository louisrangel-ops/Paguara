<?php
/**
 * Método de pago "Paguara" para WooCommerce: redirige al checkout alojado de
 * Paguara (Pago Móvil, débito inmediato, tarjetas, Zelle, USDT…) y marca el
 * pedido pagado cuando la API lo confirma.
 */

defined( 'ABSPATH' ) || exit;

class WC_Gateway_Paguara extends WC_Payment_Gateway {

	public function __construct() {
		$this->id                 = 'paguara';
		$this->method_title       = 'Paguara';
		$this->method_description = 'Cobra en bolívares y divisas con Paguara. El pagador elige el método en el checkout de Paguara y vuelve a tu tienda al pagar.';
		$this->has_fields         = false;
		$this->supports           = array( 'products' ); // Paguara todavía no tiene API de reembolsos.

		$this->init_form_fields();
		$this->init_settings();
		$this->title       = $this->get_option( 'title' );
		$this->description = $this->get_option( 'description' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
		add_action( 'woocommerce_api_paguara', array( $this, 'handle_api_request' ) );
	}

	public function init_form_fields() {
		$webhook = WC()->api_request_url( 'paguara' );
		$this->form_fields = array(
			'enabled'              => array(
				'title'   => 'Activar',
				'type'    => 'checkbox',
				'label'   => 'Cobrar con Paguara',
				'default' => 'no',
			),
			'title'                => array(
				'title'   => 'Título',
				'type'    => 'text',
				'default' => 'Pago Móvil, transferencia, tarjeta o USDT',
			),
			'description'          => array(
				'title'   => 'Descripción',
				'type'    => 'textarea',
				'default' => 'Te llevamos al checkout seguro de Paguara para pagar en bolívares o divisas.',
			),
			'testmode'             => array(
				'title'       => 'Modo pruebas',
				'type'        => 'checkbox',
				'label'       => 'Usar el sandbox de Paguara (no se mueve dinero)',
				'default'     => 'yes',
				'description' => 'En pruebas se usan las llaves sk_test_ y pk_test_ contra la URL del sandbox.',
			),
			'test_api_url'         => array(
				'title'       => 'URL del sandbox',
				'type'        => 'text',
				'placeholder' => 'https://sandbox.paguara.com',
			),
			'test_secret_key'      => array(
				'title' => 'Llave secreta de prueba',
				'type'  => 'password',
			),
			'test_publishable_key' => array(
				'title' => 'Llave publicable de prueba',
				'type'  => 'text',
			),
			'test_webhook_secret'  => array(
				'title'       => 'Secreto del webhook de prueba',
				'type'        => 'password',
				'description' => 'Crea un endpoint en el panel de Paguara (Desarrolladores → Webhooks) con esta URL: <code>' . esc_html( $webhook ) . '</code> y pega aquí su whsec_.',
			),
			'live_api_url'         => array(
				'title'       => 'URL de producción',
				'type'        => 'text',
				'placeholder' => 'https://api.paguara.com',
			),
			'live_secret_key'      => array(
				'title' => 'Llave secreta de producción',
				'type'  => 'password',
			),
			'live_publishable_key' => array(
				'title' => 'Llave publicable de producción',
				'type'  => 'text',
			),
			'live_webhook_secret'  => array(
				'title'       => 'Secreto del webhook de producción',
				'type'        => 'password',
				'description' => 'Mismo endpoint (<code>' . esc_html( $webhook ) . '</code>), creado con la cuenta en producción.',
			),
			'debug'                => array(
				'title'   => 'Registro',
				'type'    => 'checkbox',
				'label'   => 'Guardar registro en WooCommerce → Estado → Registros (fuente "paguara"). Nunca guarda llaves.',
				'default' => 'no',
			),
		);
	}

	private function livemode(): bool {
		return 'yes' !== $this->get_option( 'testmode', 'yes' );
	}

	private function opt( string $name ): string {
		return trim( (string) $this->get_option( ( $this->livemode() ? 'live_' : 'test_' ) . $name ) );
	}

	/** Las llaves deben ser del entorno elegido; si no, la API respondería 401 wrong_environment. */
	private function configured(): bool {
		$env = $this->livemode() ? 'live' : 'test';
		return '' !== $this->opt( 'api_url' )
			&& preg_match( "/^sk_{$env}_[A-Za-z0-9]{32}$/", $this->opt( 'secret_key' ) )
			&& preg_match( "/^pk_{$env}_[A-Za-z0-9]{32}$/", $this->opt( 'publishable_key' ) );
	}

	public function is_available() {
		return parent::is_available() && $this->configured() && Paguara_Amount::is_supported( get_woocommerce_currency() );
	}

	public function admin_options() {
		if ( 'yes' === $this->get_option( 'enabled' ) && ! $this->configured() ) {
			echo '<div class="notice notice-warning inline"><p>Paguara no aparecerá en el checkout hasta que pongas la URL y las dos llaves del modo elegido (pruebas: sk_test_/pk_test_; producción: sk_live_/pk_live_).</p></div>';
		}
		if ( ! Paguara_Amount::is_supported( get_woocommerce_currency() ) ) {
			echo '<div class="notice notice-warning inline"><p>La moneda de la tienda debe ser VES, USD, EUR o USDT.</p></div>';
		}
		parent::admin_options();
	}

	private function flow(): Paguara_Payment_Flow {
		return new Paguara_Payment_Flow(
			new Paguara_Client( $this->opt( 'api_url' ), $this->opt( 'secret_key' ) ),
			$this->opt( 'publishable_key' ),
			$this->livemode(),
			WC()->api_request_url( 'paguara' ),
			substr( md5( home_url() ), 0, 8 ),
			array( $this, 'paguara_log' )
		);
	}

	public function paguara_log( string $message ): void {
		if ( 'yes' === $this->get_option( 'debug' ) ) {
			wc_get_logger()->info( $message, array( 'source' => 'paguara' ) );
		}
	}

	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );
		try {
			return array(
				'result'   => 'success',
				'redirect' => $this->flow()->start( $order ),
			);
		} catch ( Paguara_Api_Exception $e ) {
			$this->paguara_log( "Pedido $order_id: {$e->error_code} {$e->getMessage()}" );
			wc_add_notice( 'No pudimos iniciar el pago con Paguara: ' . $e->getMessage(), 'error' );
		} catch ( InvalidArgumentException $e ) {
			wc_add_notice( $e->getMessage(), 'error' );
		}
		return array( 'result' => 'failure' );
	}

	/** /?wc-api=paguara: GET es el regreso del pagador; POST es el webhook. */
	public function handle_api_request() {
		$flow = $this->flow();
		if ( 'POST' === ( $_SERVER['REQUEST_METHOD'] ?? '' ) ) {
			$status = $flow->handle_webhook(
				(string) file_get_contents( 'php://input' ),
				(string) ( $_SERVER['HTTP_WEBHOOK_SIGNATURE'] ?? '' ),
				$this->opt( 'webhook_secret' ),
				'wc_get_order'
			);
			status_header( $status );
			exit;
		}
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- la llave del pedido protege esta ruta.
		$order_id = absint( $_GET['order_id'] ?? 0 );
		$key      = sanitize_text_field( wp_unslash( $_GET['key'] ?? '' ) );
		// phpcs:enable
		try {
			$out = $flow->handle_return( $order_id ? wc_get_order( $order_id ) : null, $key, wc_get_cart_url() );
		} catch ( InvalidArgumentException $e ) {
			wp_safe_redirect( wc_get_cart_url() );
			exit;
		} catch ( Paguara_Api_Exception $e ) {
			$this->paguara_log( "Retorno del pedido $order_id: {$e->error_code}" );
			$out = array(
				'redirect' => wc_get_order( $order_id )->get_checkout_order_received_url(),
				'notice'   => null, // El webhook terminará de confirmar el pedido.
			);
		}
		if ( $out['notice'] ) {
			wc_add_notice( $out['notice'], 'notice' );
		}
		wp_safe_redirect( $out['redirect'] );
		exit;
	}
}
