<?php
/**
 * El flujo de cobro, separado de WordPress para poder probarlo:
 *
 * 1. start(): crea (o reutiliza) un PaymentIntent para el pedido y devuelve la
 *    URL del checkout alojado de Paguara.
 * 2. El pagador paga y vuelve por return_url → handle_return().
 * 3. Paguara avisa por webhook firmado → handle_webhook().
 *
 * En 2 y 3 nunca se cree lo que dice el navegador ni el cuerpo del webhook:
 * se consulta el pago con la llave secreta y se aplica lo que responde la API (sync()).
 */

defined( 'ABSPATH' ) || exit;

final class Paguara_Payment_Flow {

	/** Estados en los que el pago todavía puede completarse (src/payment-intents/payment-intent.state-machine.ts). */
	const OPEN = array( 'requires_payment_method', 'requires_confirmation', 'requires_action', 'processing' );

	const META_INTENT   = '_paguara_payment_intent';
	const META_ATTEMPT  = '_paguara_attempt';
	const META_AMOUNT   = '_paguara_amount';
	const META_CURRENCY = '_paguara_currency';
	const META_LIVEMODE = '_paguara_livemode';

	/** @var Paguara_Client */
	private $client;
	/** @var string */
	private $publishable_key;
	/** @var bool */
	private $livemode;
	/** @var string URL de retorno sin parámetros del pedido (WC()->api_request_url('paguara')). */
	private $return_base;
	/** @var string Distingue dos tiendas que usen la misma cuenta de Paguara. */
	private $site_id;
	/** @var callable(string):void */
	private $log;

	public function __construct( Paguara_Client $client, string $publishable_key, bool $livemode, string $return_base, string $site_id, ?callable $log = null ) {
		$this->client          = $client;
		$this->publishable_key = $publishable_key;
		$this->livemode        = $livemode;
		$this->return_base     = $return_base;
		$this->site_id         = $site_id;
		$this->log             = $log ?? static function () {};
	}

	/**
	 * @param WC_Order $order
	 * @return string URL del checkout de Paguara.
	 * @throws Paguara_Api_Exception|InvalidArgumentException
	 */
	public function start( $order ): string {
		$currency = strtoupper( $order->get_currency() );
		$amount   = Paguara_Amount::to_minor( (string) $order->get_total(), $currency );

		// Si el pagador vuelve a intentar, se reutiliza el pago abierto en vez de crear otro.
		$existing = (string) $order->get_meta( self::META_INTENT );
		if ( '' !== $existing ) {
			try {
				$pi = $this->client->retrieve_payment_intent( $existing );
				if ( in_array( $pi['status'], self::OPEN, true ) && $pi['amount'] === $amount && $pi['currency'] === $currency
					&& (bool) $pi['livemode'] === $this->livemode ) {
					return $this->client->checkout_url( $pi, $this->publishable_key );
				}
			} catch ( Paguara_Api_Exception $e ) {
				// Otro entorno (pruebas ↔ producción) o pago inexistente: se crea uno nuevo.
				call_user_func( $this->log, "No se pudo reutilizar $existing: {$e->error_code}" );
			}
		}

		// La llave es estable por intento: un doble clic en "Pagar" no crea dos pagos.
		$attempt = (int) $order->get_meta( self::META_ATTEMPT ) + 1;
		$key     = 'wc-' . $this->site_id . '-' . $order->get_id() . '-' . $attempt;
		$pi      = $this->client->create_payment_intent(
			array(
				'amount'     => $amount,
				'currency'   => $currency,
				'return_url' => $this->return_url( $order ),
				'metadata'   => array(
					'source'       => 'woocommerce',
					'order_id'     => (string) $order->get_id(),
					'order_number' => (string) $order->get_order_number(),
					'description'  => 'Pedido #' . $order->get_order_number(),
				),
				'customer'   => array_filter(
					array(
						'email' => (string) $order->get_billing_email(),
						'name'  => (string) $order->get_formatted_billing_full_name(),
					)
				),
			),
			$key
		);

		$order->update_meta_data( self::META_INTENT, $pi['id'] );
		$order->update_meta_data( self::META_ATTEMPT, (string) $attempt );
		$order->update_meta_data( self::META_AMOUNT, $amount );
		$order->update_meta_data( self::META_CURRENCY, $currency );
		$order->update_meta_data( self::META_LIVEMODE, $this->livemode ? 'yes' : 'no' );
		$order->save();
		$order->add_order_note( sprintf( 'Pago creado en Paguara: %s%s.', $pi['id'], $this->livemode ? '' : ' (modo pruebas)' ) );
		return $this->client->checkout_url( $pi, $this->publishable_key );
	}

	/**
	 * El pagador vuelve del checkout. Devuelve a dónde redirigirlo y, si hace falta,
	 * un aviso para mostrarle.
	 *
	 * @param WC_Order|null $order
	 * @param string        $cart_url A dónde va si el pago se canceló o venció (ya no se puede pagar ese pedido).
	 * @return array{redirect:string, notice:?string}
	 */
	public function handle_return( $order, string $order_key, string $cart_url ): array {
		if ( ! $order || '' === $order_key || ! hash_equals( (string) $order->get_order_key(), $order_key ) ) {
			throw new InvalidArgumentException( 'Pedido no encontrado' );
		}
		$id = (string) $order->get_meta( self::META_INTENT );
		if ( '' !== $id && ! $order->is_paid() ) {
			$this->sync( $order, $this->client->retrieve_payment_intent( $id ) );
		}
		if ( $order->is_paid() || $order->has_status( 'on-hold' ) ) {
			return array(
				'redirect' => $order->get_checkout_order_received_url(),
				'notice'   => null,
			);
		}
		if ( $order->has_status( 'cancelled' ) ) {
			return array(
				'redirect' => $cart_url,
				'notice'   => 'El pago se canceló o venció. Haz el pedido de nuevo.',
			);
		}
		return array(
			'redirect' => $order->get_checkout_payment_url(),
			'notice'   => 'Tu pago no se completó. Puedes intentarlo de nuevo.',
		);
	}

	/**
	 * Webhook de Paguara. Devuelve el estado HTTP a responder: 400 si la firma no
	 * sirve (Paguara reintenta), 200 si se procesó o no era para esta tienda, 500
	 * si la API no respondió (Paguara reintenta más tarde).
	 *
	 * @param callable(int):(WC_Order|null) $find_order
	 */
	public function handle_webhook( string $body, string $signature, string $secret, callable $find_order, ?int $now = null ): int {
		if ( ! Paguara_Signature::verify( $signature, $body, $secret, $now ) ) {
			call_user_func( $this->log, 'Webhook con firma inválida' );
			return 400;
		}
		$event = json_decode( $body, true );
		$pi    = $event['data']['object'] ?? null;
		if ( ! is_array( $event ) || ! is_array( $pi ) || 0 !== strpos( (string) ( $event['type'] ?? '' ), 'payment_intent.' )
			|| (bool) ( $event['livemode'] ?? false ) !== $this->livemode
			|| 'woocommerce' !== ( $pi['metadata']['source'] ?? null ) || ! ctype_digit( (string) ( $pi['metadata']['order_id'] ?? '' ) ) ) {
			return 200; // No es un pago de esta tienda.
		}
		$order = call_user_func( $find_order, (int) $pi['metadata']['order_id'] );
		if ( ! $order || $order->get_meta( self::META_INTENT ) !== ( $pi['id'] ?? null ) ) {
			return 200; // Pago viejo de un pedido que ya tiene otro, o de otra tienda.
		}
		try {
			$this->sync( $order, $this->client->retrieve_payment_intent( $pi['id'] ) );
		} catch ( Paguara_Api_Exception $e ) {
			call_user_func( $this->log, "Webhook {$pi['id']}: la API respondió {$e->error_code}" );
			return 500;
		}
		return 200;
	}

	/**
	 * Aplica al pedido el estado del pago según la API. Idempotente: llamarlo dos
	 * veces (retorno y webhook) no duplica nada.
	 *
	 * @param WC_Order $order
	 * @return string paid | on-hold | canceled | pending | mismatch
	 */
	public function sync( $order, array $pi ): string {
		if ( $order->get_meta( self::META_INTENT ) !== ( $pi['id'] ?? null )
			|| $order->get_meta( self::META_AMOUNT ) !== ( $pi['amount'] ?? null )
			|| $order->get_meta( self::META_CURRENCY ) !== ( $pi['currency'] ?? null )
			|| (bool) ( $pi['livemode'] ?? false ) !== $this->livemode ) {
			$order->add_order_note( 'Paguara: el pago ' . ( $pi['id'] ?? '?' ) . ' no coincide con este pedido (monto, moneda o entorno). No se cambió nada.' );
			return 'mismatch';
		}
		switch ( $pi['status'] ) {
			case 'succeeded':
			case 'settled':
				if ( ! $order->is_paid() ) {
					$order->payment_complete( $pi['id'] );
					$order->add_order_note( 'Paguara confirmó el pago ' . $pi['id'] . $this->charge_text( $pi ) . '.' );
				}
				return 'paid';
			case 'processing':
				if ( $order->has_status( 'pending' ) ) {
					$order->update_status( 'on-hold', 'Paguara: esperando la respuesta del banco.' );
				}
				return 'on-hold';
			case 'canceled':
				if ( ! $order->is_paid() && $order->has_status( array( 'pending', 'on-hold', 'failed' ) ) ) {
					$order->update_status( 'cancelled', 'Paguara canceló el pago (' . ( $pi['cancellation_reason'] ?? 'sin motivo' ) . ').' );
				}
				return 'canceled';
			default:
				return 'pending';
		}
	}

	private function return_url( $order ): string {
		$sep = false === strpos( $this->return_base, '?' ) ? '?' : '&';
		return $this->return_base . $sep . http_build_query(
			array(
				'order_id' => $order->get_id(),
				'key'      => $order->get_order_key(),
			)
		);
	}

	private function charge_text( array $pi ): string {
		if ( empty( $pi['charge'] ) ) {
			return '';
		}
		$c   = $pi['charge'];
		$exp = Paguara_Amount::EXPONENT[ $c['currency'] ] ?? 2;
		$amt = str_pad( $c['amount'], $exp + 1, '0', STR_PAD_LEFT );
		return sprintf( ' (%s %s,%s con %s)', $c['currency'], substr( $amt, 0, -$exp ), substr( $amt, -$exp ), $pi['payment_method_type'] ?? 'método desconocido' );
	}
}
