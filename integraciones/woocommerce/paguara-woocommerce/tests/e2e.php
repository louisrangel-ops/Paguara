<?php
/**
 * Prueba de punta a punta contra una API de Paguara de verdad (sandbox local):
 * crea el pago como lo haría WooCommerce, lo paga por el checkout con Pago Móvil
 * C2P del sandbox, espera el webhook firmado y revisa que el pedido quedó pagado.
 *
 * Necesita: la API corriendo con WEBHOOK_ALLOW_HTTP=true y WEBHOOK_ALLOW_PRIVATE=true,
 * tasas cargadas, y estas variables: PAGUARA_API_URL, PAGUARA_SECRET_KEY,
 * PAGUARA_PUBLISHABLE_KEY, PAGUARA_WEBHOOK_SECRET (de un endpoint que apunte a
 * http://127.0.0.1:PAGUARA_E2E_PORT/) y PAGUARA_E2E_PORT (8099 por defecto).
 * Pasos en docs/integraciones/woocommerce.md.
 */

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/e2e-lib.php';

function check( $cond, string $msg ) {
	if ( ! $cond ) {
		fwrite( STDERR, "FALLÓ: $msg\n" );
		exit( 1 );
	}
	echo "ok - $msg\n";
}

$port  = getenv( 'PAGUARA_E2E_PORT' ) ?: '8099';
$state = tempnam( sys_get_temp_dir(), 'paguara-e2e' );
putenv( "PAGUARA_E2E_STATE=$state" );
$server = proc_open( array( PHP_BINARY, '-S', "127.0.0.1:$port", __DIR__ . '/e2e-receiver.php' ), array( array( 'pipe', 'r' ), array( 'file', '/dev/null', 'w' ), array( 'file', '/dev/null', 'w' ) ), $pipes );
register_shutdown_function( function () use ( $server, $state ) { proc_terminate( $server ); @unlink( $state ); } );
usleep( 300000 );

// 1. WooCommerce crea el pago y manda al pagador al checkout.
$order = new Fake_Order( random_int( 1000, 999999 ), '25.00', 'USD' );
$flow  = paguara_e2e_flow();
$url   = $flow->start( $order );
file_put_contents( $state, serialize( $order ) );
parse_str( (string) parse_url( $url, PHP_URL_QUERY ), $q );
check( 0 === strpos( $url, rtrim( getenv( 'PAGUARA_API_URL' ), '/' ) . '/checkout?' ) && $q['pi'] && $q['cs'] && $q['pk'], 'redirige al checkout alojado con pi, cs y pk' );

// 2. El navegador del pagador: la página carga y la API del checkout ve la return_url.
$api  = rtrim( getenv( 'PAGUARA_API_URL' ), '/' );
$auth = array( 'Authorization' => 'Bearer ' . $q['pk'], 'Content-Type' => 'application/json' );
$page = paguara_e2e_transport( 'GET', $url, array(), null );
check( 200 === $page['status'], 'la página del checkout responde 200' );
$pi = json_decode( paguara_e2e_transport( 'GET', "$api/v1/checkout/payment_intents/{$q['pi']}?client_secret={$q['cs']}", $auth, null )['body'], true );
check( 0 === strpos( $pi['return_url'] ?? '', 'http://tienda.local/?wc-api=paguara&order_id=' . $order->get_id() . '&key=' ), 'el checkout recibe la return_url del pedido' );

// 3. Paga con Pago Móvil C2P en el sandbox.
$r = paguara_e2e_transport( 'POST', "$api/v1/checkout/payment_intents/{$q['pi']}/attach", $auth + array( 'Idempotency-Key' => uniqid( 'a' ) ), json_encode( array( 'client_secret' => $q['cs'], 'payment_method_type' => 'pago_movil_c2p' ) ) );
check( 200 === $r['status'], 'elige Pago Móvil C2P (' . $r['status'] . ')' );
$r  = paguara_e2e_transport( 'POST', "$api/v1/checkout/payment_intents/{$q['pi']}/confirm", $auth + array( 'Idempotency-Key' => uniqid( 'c' ) ), json_encode( array( 'client_secret' => $q['cs'], 'payment_method_details' => array( 'bank' => '0102', 'document' => 'V-12345678', 'phone' => '04141234567', 'otp' => '123456' ) ) ) );
$pi = json_decode( $r['body'], true );
check( 'succeeded' === ( $pi['status'] ?? null ), 'el sandbox confirma el pago' );

// 4. El webhook firmado llega a la tienda y el pedido queda pagado.
for ( $i = 0; $i < 40; $i++ ) {
	clearstatcache();
	$order = unserialize( file_get_contents( $state ) );
	if ( 'processing' === $order->status ) {
		break;
	}
	usleep( 250000 );
}
check( 'processing' === $order->status && $order->transaction_id === $q['pi'], 'el webhook firmado marcó el pedido como pagado' );

// 5. El pagador vuelve a la tienda: ya está pagado, va a "pedido recibido".
$out = $flow->handle_return( $order, $order->get_order_key(), '/carrito' );
check( $out['redirect'] === $order->get_checkout_order_received_url(), 'el regreso lleva a "pedido recibido"' );
echo "# punta a punta ok\n";
