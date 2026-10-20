<?php
/**
 * Cliente mínimo de la API v1 de Paguara (docs/api.md). Usa la llave secreta:
 * solo corre en el servidor de la tienda, nunca en el navegador.
 */

defined( 'ABSPATH' ) || exit;

class Paguara_Api_Exception extends Exception {
	/** @var string Código de error de Paguara (p. ej. currency_invalid) o de red. */
	public $error_code;
	/** @var int Estado HTTP (0 si no hubo respuesta). */
	public $http_status;

	public function __construct( string $message, string $error_code, int $http_status ) {
		parent::__construct( $message );
		$this->error_code  = $error_code;
		$this->http_status = $http_status;
	}
}

class Paguara_Client {

	const VERSION = '0.1.0';

	/** @var string */
	private $base_url;
	/** @var string */
	private $secret_key;
	/** @var callable(string,string,array,?string):array{status:int,body:string} */
	private $transport;

	/**
	 * @param callable|null $transport Para pruebas. Por defecto, wp_remote_request.
	 */
	public function __construct( string $base_url, string $secret_key, ?callable $transport = null ) {
		$this->base_url   = rtrim( $base_url, '/' );
		$this->secret_key = $secret_key;
		$this->transport  = $transport ?? array( __CLASS__, 'wp_transport' );
	}

	public function create_payment_intent( array $body, string $idempotency_key ): array {
		return $this->request( 'POST', '/v1/payment_intents', $body, $idempotency_key );
	}

	public function retrieve_payment_intent( string $id ): array {
		if ( ! self::is_payment_intent_id( $id ) ) {
			throw new Paguara_Api_Exception( "Id de pago inválido: $id", 'resource_missing', 0 );
		}
		return $this->request( 'GET', '/v1/payment_intents/' . $id );
	}

	/** URL del checkout alojado: GET /checkout?pi=&cs=&pk= (src/checkout-page.controller.ts). */
	public function checkout_url( array $pi, string $publishable_key ): string {
		return $this->base_url . '/checkout?' . http_build_query(
			array(
				'pi' => $pi['id'],
				'cs' => $pi['client_secret'],
				'pk' => $publishable_key,
			)
		);
	}

	public static function is_payment_intent_id( string $id ): bool {
		return (bool) preg_match( '/^pi_[a-f0-9]{24}$/', $id );
	}

	private function request( string $method, string $path, ?array $body = null, ?string $idempotency_key = null ): array {
		$headers = array(
			'Authorization' => 'Bearer ' . $this->secret_key,
			'Accept'        => 'application/json',
			'User-Agent'    => 'PaguaraWooCommerce/' . self::VERSION,
		);
		if ( null !== $body ) {
			$headers['Content-Type'] = 'application/json';
		}
		if ( null !== $idempotency_key ) {
			$headers['Idempotency-Key'] = $idempotency_key;
		}
		$res  = call_user_func( $this->transport, $method, $this->base_url . $path, $headers, null === $body ? null : json_encode( $body ) );
		$data = json_decode( (string) $res['body'], true );
		if ( $res['status'] >= 200 && $res['status'] < 300 && is_array( $data ) ) {
			return $data;
		}
		$err = is_array( $data ) && isset( $data['error'] ) ? $data['error'] : array();
		throw new Paguara_Api_Exception(
			$err['message'] ?? ( $res['status'] ? 'Respuesta inesperada de Paguara (HTTP ' . $res['status'] . ')' : 'No se pudo conectar con Paguara' ),
			$err['code'] ?? ( $res['status'] ? 'unexpected_response' : 'network_error' ),
			(int) $res['status']
		);
	}

	/** @return array{status:int,body:string} */
	public static function wp_transport( string $method, string $url, array $headers, ?string $body ): array {
		$args = array(
			'method'  => $method,
			'headers' => $headers,
			'timeout' => 20,
		);
		if ( null !== $body ) {
			$args['body'] = $body;
		}
		$res = wp_remote_request( $url, $args );
		if ( is_wp_error( $res ) ) {
			return array(
				'status' => 0,
				'body'   => '',
			);
		}
		return array(
			'status' => (int) wp_remote_retrieve_response_code( $res ),
			'body'   => (string) wp_remote_retrieve_body( $res ),
		);
	}
}
