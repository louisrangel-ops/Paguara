<?php

test( 'montos: decimales de la tienda a unidades mínimas, sin float', function () {
	eq( '1250', Paguara_Amount::to_minor( '12.5', 'USD' ) );
	eq( '1250', Paguara_Amount::to_minor( '12.50', 'usd' ) );
	eq( '36500000', Paguara_Amount::to_minor( '365000', 'VES' ) );
	eq( '1', Paguara_Amount::to_minor( '0.01', 'EUR' ) );
	eq( '10000000', Paguara_Amount::to_minor( '10', 'USDT' ) );
	eq( '1999', Paguara_Amount::to_minor( '19.990', 'USD' ), 'ceros de más a la derecha no son decimales reales' );
	eq( '29', Paguara_Amount::to_minor( '0.29', 'USD' ), '0.29 en float es 28.999…' );
} );

test( 'montos: rechaza monedas, formatos y precisión que Paguara no acepta', function () {
	throws( function () { Paguara_Amount::to_minor( '10', 'COP' ); }, InvalidArgumentException::class, 'COP' );
	throws( function () { Paguara_Amount::to_minor( '0', 'USD' ); }, InvalidArgumentException::class, 'cero' );
	throws( function () { Paguara_Amount::to_minor( '-5', 'USD' ); }, InvalidArgumentException::class, 'negativo' );
	throws( function () { Paguara_Amount::to_minor( '1e3', 'USD' ); }, InvalidArgumentException::class, 'notación científica' );
	throws( function () { Paguara_Amount::to_minor( '1.005', 'USD' ); }, InvalidArgumentException::class, 'tres decimales en USD' );
} );

test( 'firma: acepta la de Paguara y rechaza cuerpo, secreto o tiempo distintos', function () {
	$body = '{"id":"evt_1","type":"payment_intent.succeeded"}';
	$t    = 1760900000;
	$h    = Paguara_Signature::header( $body, 'whsec_abc', $t );
	eq( true, Paguara_Signature::verify( $h, $body, 'whsec_abc', $t ) );
	eq( true, Paguara_Signature::verify( $h, $body, 'whsec_abc', $t + 299 ), 'dentro de la tolerancia' );
	eq( false, Paguara_Signature::verify( $h, $body, 'whsec_abc', $t + 301 ), 'evento viejo reenviado' );
	eq( false, Paguara_Signature::verify( $h, $body . ' ', 'whsec_abc', $t ), 'cuerpo alterado' );
	eq( false, Paguara_Signature::verify( $h, $body, 'whsec_otro', $t ), 'otro secreto' );
	eq( false, Paguara_Signature::verify( $h, $body, '', $t ), 'sin secreto configurado' );
	eq( false, Paguara_Signature::verify( 't=' . $t, $body, 'whsec_abc', $t ), 'sin v1' );
	eq( false, Paguara_Signature::verify( 'basura', $body, 'whsec_abc', $t ) );
	eq( true, Paguara_Signature::verify( "t=$t,v1=00,v1=" . substr( $h, strpos( $h, 'v1=' ) + 3 ), $body, 'whsec_abc', $t ), 'varias firmas (rotación)' );
} );

test( 'firma: coincide con la del servidor (HMAC de "t.cuerpo" en hex)', function () {
	// Mismo cálculo que signPayload en src/webhooks/webhooks.service.ts.
	eq( 't=1,v1=' . hash_hmac( 'sha256', '1.{}', 's' ), Paguara_Signature::header( '{}', 's', 1 ) );
} );
