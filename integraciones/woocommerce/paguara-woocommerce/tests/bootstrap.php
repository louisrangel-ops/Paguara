<?php
/**
 * Pruebas sin WordPress: cargan las clases puras del plugin y un pedido falso
 * con los métodos de WC_Order que usa el flujo. Correr: php tests/run.php
 */

define( 'ABSPATH', __DIR__ );
require_once __DIR__ . '/../includes/class-paguara-amount.php';
require_once __DIR__ . '/../includes/class-paguara-signature.php';
require_once __DIR__ . '/../includes/class-paguara-client.php';
require_once __DIR__ . '/../includes/class-paguara-payment-flow.php';

/** Lo justo de WC_Order: meta, estados y las transiciones de payment_complete/update_status. */
class Fake_Order {
	public $id;
	public $total;
	public $currency;
	public $status = 'pending';
	public $meta   = array();
	public $notes  = array();
	public $transaction_id = null;
	public $saves  = 0;

	public function __construct( int $id, string $total, string $currency ) {
		$this->id       = $id;
		$this->total    = $total;
		$this->currency = $currency;
	}
	public function get_id() { return $this->id; }
	public function get_order_number() { return (string) $this->id; }
	public function get_order_key() { return 'wc_order_k' . $this->id; }
	public function get_total() { return $this->total; }
	public function get_currency() { return $this->currency; }
	public function get_billing_email() { return 'ana@example.com'; }
	public function get_formatted_billing_full_name() { return 'Ana Pérez'; }
	public function get_meta( $k ) { return $this->meta[ $k ] ?? ''; }
	public function update_meta_data( $k, $v ) { $this->meta[ $k ] = $v; }
	public function save() { $this->saves++; }
	public function add_order_note( $n ) { $this->notes[] = $n; }
	public function is_paid() { return in_array( $this->status, array( 'processing', 'completed' ), true ); }
	public function has_status( $s ) { return in_array( $this->status, (array) $s, true ); }
	public function payment_complete( $tx ) { $this->status = 'processing'; $this->transaction_id = $tx; }
	public function update_status( $s, $note = '' ) { $this->status = $s; if ( $note ) { $this->notes[] = $note; } }
	public function get_checkout_order_received_url() { return 'https://tienda.test/pedido-recibido/' . $this->id; }
	public function get_checkout_payment_url() { return 'https://tienda.test/pagar/' . $this->id; }
}

/** API de Paguara falsa: guarda los pagos en memoria y registra cada petición. */
class Fake_Api {
	public $intents  = array();
	public $requests = array();
	public $by_key   = array();
	public $fail     = null;

	public function __invoke( $method, $url, $headers, $body ) {
		$this->requests[] = compact( 'method', 'url', 'headers', 'body' );
		if ( $this->fail ) {
			return $this->fail;
		}
		if ( 'POST' === $method ) {
			$key = $headers['Idempotency-Key'];
			if ( ! isset( $this->by_key[ $key ] ) ) {
				$in = json_decode( $body, true );
				$id = 'pi_' . str_pad( dechex( count( $this->intents ) + 1 ), 24, '0', STR_PAD_LEFT );
				$this->intents[ $id ] = array(
					'id'            => $id,
					'object'        => 'payment_intent',
					'status'        => 'requires_payment_method',
					'amount'        => $in['amount'],
					'currency'      => $in['currency'],
					'metadata'      => $in['metadata'],
					'return_url'    => $in['return_url'],
					'client_secret' => $id . '_secret_abc',
					'livemode'      => false,
					'charge'        => null,
				);
				$this->by_key[ $key ] = $id;
			}
			return array( 'status' => 200, 'body' => json_encode( $this->intents[ $this->by_key[ $key ] ] ) );
		}
		$id = substr( $url, strrpos( $url, '/' ) + 1 );
		if ( ! isset( $this->intents[ $id ] ) ) {
			return array( 'status' => 404, 'body' => json_encode( array( 'error' => array( 'type' => 'invalid_request_error', 'code' => 'resource_missing', 'message' => "No existe el PaymentIntent $id" ) ) ) );
		}
		return array( 'status' => 200, 'body' => json_encode( $this->intents[ $id ] ) );
	}
}
