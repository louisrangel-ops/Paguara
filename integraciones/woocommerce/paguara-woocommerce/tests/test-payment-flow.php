<?php

function paguara_flow( Fake_Api $api ): Paguara_Payment_Flow {
	return new Paguara_Payment_Flow(
		new Paguara_Client( 'https://sandbox.paguara.test/', 'sk_test_' . str_repeat( 'a', 32 ), $api ),
		'pk_test_' . str_repeat( 'b', 32 ),
		false,
		'https://tienda.test/?wc-api=paguara',
		'abcd1234'
	);
}

function paguara_event( array $pi, string $type = 'payment_intent.succeeded' ): string {
	unset( $pi['client_secret'] );
	return json_encode( array( 'id' => 'evt_1', 'object' => 'event', 'type' => $type, 'livemode' => false, 'created' => 1760900000, 'data' => array( 'object' => $pi ) ) );
}

test( 'start: crea el pago con monto, return_url y metadata, y manda al checkout alojado', function () {
	$api   = new Fake_Api();
	$order = new Fake_Order( 42, '12.50', 'USD' );
	$url   = paguara_flow( $api )->start( $order );

	$req  = $api->requests[0];
	$body = json_decode( $req['body'], true );
	eq( 'POST', $req['method'] );
	eq( 'https://sandbox.paguara.test/v1/payment_intents', $req['url'] );
	eq( 'Bearer sk_test_' . str_repeat( 'a', 32 ), $req['headers']['Authorization'] );
	eq( 'wc-abcd1234-42-1', $req['headers']['Idempotency-Key'] );
	eq( '1250', $body['amount'] );
	eq( 'USD', $body['currency'] );
	eq( 'https://tienda.test/?wc-api=paguara&order_id=42&key=wc_order_k42', $body['return_url'] );
	eq( array( 'source' => 'woocommerce', 'order_id' => '42', 'order_number' => '42', 'description' => 'Pedido #42' ), $body['metadata'] );

	$pi = $order->meta[ Paguara_Payment_Flow::META_INTENT ];
	eq( "https://sandbox.paguara.test/checkout?pi=$pi&cs={$pi}_secret_abc&pk=pk_test_" . str_repeat( 'b', 32 ), $url );
	eq( '1250', $order->meta[ Paguara_Payment_Flow::META_AMOUNT ] );
	eq( 'pending', $order->status );
} );

test( 'start: reintentar el mismo pedido reutiliza el pago abierto; si cambió el total crea otro', function () {
	$api   = new Fake_Api();
	$order = new Fake_Order( 7, '10.00', 'USD' );
	$flow  = paguara_flow( $api );
	$first = $flow->start( $order );
	eq( $first, $flow->start( $order ) );
	eq( 1, count( $api->intents ) );

	$order->total = '11.00';
	$flow->start( $order );
	eq( 2, count( $api->intents ) );
	eq( '2', $order->meta[ Paguara_Payment_Flow::META_ATTEMPT ] );
	eq( 'wc-abcd1234-7-2', end( $api->requests )['headers']['Idempotency-Key'] );
} );

test( 'start: moneda no soportada o error de la API no crean nada', function () {
	$api = new Fake_Api();
	throws( function () use ( $api ) { paguara_flow( $api )->start( new Fake_Order( 1, '10', 'COP' ) ); }, InvalidArgumentException::class );
	eq( 0, count( $api->requests ) );

	$api->fail = array( 'status' => 400, 'body' => '{"error":{"type":"invalid_request_error","code":"no_payment_methods_available","message":"Tu cuenta no tiene ningún método de pago activo"}}' );
	$order     = new Fake_Order( 2, '10', 'USD' );
	$e         = throws( function () use ( $api, $order ) { paguara_flow( $api )->start( $order ); }, Paguara_Api_Exception::class );
	eq( 'no_payment_methods_available', $e->error_code );
	eq( '', $order->get_meta( Paguara_Payment_Flow::META_INTENT ) );

	$api->fail = array( 'status' => 0, 'body' => '' );
	eq( 'network_error', throws( function () use ( $api, $order ) { paguara_flow( $api )->start( $order ); }, Paguara_Api_Exception::class )->error_code );
} );

test( 'webhook: firma válida + la API confirma → pedido pagado una sola vez', function () {
	$api   = new Fake_Api();
	$order = new Fake_Order( 5, '20', 'USD' );
	$flow  = paguara_flow( $api );
	$flow->start( $order );
	$id = $order->meta[ Paguara_Payment_Flow::META_INTENT ];
	$api->intents[ $id ]['status'] = 'succeeded';
	$api->intents[ $id ]['payment_method_type'] = 'pago_movil_c2p';
	$api->intents[ $id ]['charge'] = array( 'amount' => '73000', 'currency' => 'VES', 'igtf' => '0' );

	$body  = paguara_event( $api->intents[ $id ] );
	$find  = function ( $oid ) use ( $order ) { return 5 === $oid ? $order : null; };
	$now   = 1760900000;
	eq( 200, $flow->handle_webhook( $body, Paguara_Signature::header( $body, 'whsec_x', $now ), 'whsec_x', $find, $now ) );
	eq( 'processing', $order->status );
	eq( $id, $order->transaction_id );
	eq( 'Paguara confirmó el pago ' . $id . ' (VES 730,00 con pago_movil_c2p).', end( $order->notes ) );

	$notes = count( $order->notes );
	eq( 200, $flow->handle_webhook( $body, Paguara_Signature::header( $body, 'whsec_x', $now ), 'whsec_x', $find, $now ), 'reentrega' );
	eq( $notes, count( $order->notes ), 'la reentrega no duplica notas' );
} );

test( 'webhook: no confía en el cuerpo, consulta la API', function () {
	$api   = new Fake_Api();
	$order = new Fake_Order( 6, '20', 'USD' );
	$flow  = paguara_flow( $api );
	$flow->start( $order );
	$id = $order->meta[ Paguara_Payment_Flow::META_INTENT ];
	// Alguien con el secreto filtrado dice "succeeded", pero la API dice que sigue sin pagar.
	$fake          = $api->intents[ $id ];
	$fake['status'] = 'succeeded';
	$body = paguara_event( $fake );
	eq( 200, $flow->handle_webhook( $body, Paguara_Signature::header( $body, 'w', 100 ), 'w', function () use ( $order ) { return $order; }, 100 ) );
	eq( 'pending', $order->status );
} );

test( 'webhook: firma mala → 400; pago ajeno, de otro entorno o viejo → 200 sin tocar nada; API caída → 500', function () {
	$api   = new Fake_Api();
	$order = new Fake_Order( 8, '20', 'USD' );
	$flow  = paguara_flow( $api );
	$flow->start( $order );
	$pi   = $api->intents[ $order->meta[ Paguara_Payment_Flow::META_INTENT ] ];
	$find = function () use ( $order ) { return $order; };
	$sig  = function ( $b ) { return Paguara_Signature::header( $b, 'w', 100 ); };

	$body = paguara_event( $pi );
	eq( 400, $flow->handle_webhook( $body, $sig( $body ), 'otro', $find, 100 ) );

	$other                         = $pi;
	$other['metadata']['source']   = 'shopify';
	$b = paguara_event( $other );
	eq( 200, $flow->handle_webhook( $b, $sig( $b ), 'w', $find, 100 ) );

	$old       = $pi;
	$old['id'] = 'pi_' . str_repeat( 'f', 24 );
	$b         = paguara_event( $old );
	eq( 200, $flow->handle_webhook( $b, $sig( $b ), 'w', $find, 100 ) );

	$live = json_decode( paguara_event( $pi ), true );
	$live['livemode'] = true;
	$b = json_encode( $live );
	eq( 200, $flow->handle_webhook( $b, $sig( $b ), 'w', $find, 100 ) );
	eq( 1, count( $api->requests ), 'ninguno de esos consultó la API' );

	$api->fail = array( 'status' => 503, 'body' => '' );
	eq( 500, $flow->handle_webhook( $body, $sig( $body ), 'w', $find, 100 ) );
	eq( 'pending', $order->status );
} );

test( 'sync: processing → en espera; canceled → cancelado; monto distinto → no toca el pedido', function () {
	$api   = new Fake_Api();
	$order = new Fake_Order( 9, '20', 'USD' );
	$flow  = paguara_flow( $api );
	$flow->start( $order );
	$pi = $api->intents[ $order->meta[ Paguara_Payment_Flow::META_INTENT ] ];

	eq( 'mismatch', $flow->sync( $order, array_merge( $pi, array( 'status' => 'succeeded', 'amount' => '1' ) ) ) );
	eq( 'pending', $order->status );
	eq( 'mismatch', $flow->sync( $order, array_merge( $pi, array( 'status' => 'succeeded', 'livemode' => true ) ) ) );

	eq( 'on-hold', $flow->sync( $order, array_merge( $pi, array( 'status' => 'processing' ) ) ) );
	eq( 'on-hold', $order->status );
	eq( 'canceled', $flow->sync( $order, array_merge( $pi, array( 'status' => 'canceled', 'cancellation_reason' => 'expired' ) ) ) );
	eq( 'cancelled', $order->status );
	eq( 'Paguara canceló el pago (expired).', end( $order->notes ) );
} );

test( 'retorno: la llave del pedido es obligatoria; pagado → gracias; sin pagar → reintentar; cancelado → carrito', function () {
	$api   = new Fake_Api();
	$order = new Fake_Order( 11, '20', 'USD' );
	$flow  = paguara_flow( $api );
	$flow->start( $order );
	$id = $order->meta[ Paguara_Payment_Flow::META_INTENT ];

	throws( function () use ( $flow, $order ) { $flow->handle_return( $order, 'wc_order_kOTRO', '/carrito' ); }, InvalidArgumentException::class );
	throws( function () use ( $flow ) { $flow->handle_return( null, 'x', '/carrito' ); }, InvalidArgumentException::class );

	$out = $flow->handle_return( $order, 'wc_order_k11', '/carrito' );
	eq( 'https://tienda.test/pagar/11', $out['redirect'] );
	eq( 'Tu pago no se completó. Puedes intentarlo de nuevo.', $out['notice'] );

	$api->intents[ $id ]['status'] = 'succeeded';
	$out = $flow->handle_return( $order, 'wc_order_k11', '/carrito' );
	eq( array( 'redirect' => 'https://tienda.test/pedido-recibido/11', 'notice' => null ), $out );
	eq( 'processing', $order->status );

	$o2 = new Fake_Order( 12, '20', 'USD' );
	$flow->start( $o2 );
	$api->intents[ $o2->meta[ Paguara_Payment_Flow::META_INTENT ] ]['status'] = 'canceled';
	eq( '/carrito', $flow->handle_return( $o2, 'wc_order_k12', '/carrito' )['redirect'] );
} );

test( 'cliente: no arma URLs con ids que no son de Paguara', function () {
	$api = new Fake_Api();
	$c   = new Paguara_Client( 'https://x.test', 'sk', $api );
	throws( function () use ( $c ) { $c->retrieve_payment_intent( '../internal/whoami' ); }, Paguara_Api_Exception::class );
	eq( 0, count( $api->requests ) );
} );
