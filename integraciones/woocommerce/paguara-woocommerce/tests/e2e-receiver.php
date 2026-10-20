<?php
/**
 * Tienda mínima para tests/e2e.php: recibe el webhook de Paguara en un
 * `php -S` y lo procesa con el mismo flujo del plugin. El pedido vive en un
 * archivo (PAGUARA_E2E_STATE) para que el script de la prueba lo lea.
 */

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/e2e-lib.php';

$state = getenv( 'PAGUARA_E2E_STATE' );
$order = unserialize( file_get_contents( $state ) );
$code  = paguara_e2e_flow()->handle_webhook(
	file_get_contents( 'php://input' ),
	$_SERVER['HTTP_WEBHOOK_SIGNATURE'] ?? '',
	getenv( 'PAGUARA_WEBHOOK_SECRET' ),
	function ( $id ) use ( $order ) { return $id === $order->get_id() ? $order : null; }
);
file_put_contents( $state, serialize( $order ) );
http_response_code( $code );
