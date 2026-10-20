<?php
/** Transporte con curl (en WordPress se usa wp_remote_request) y el flujo configurado por variables de entorno. */

function paguara_e2e_transport( $method, $url, $headers, $body ) {
	$ch = curl_init( $url );
	$h  = array();
	foreach ( $headers as $k => $v ) {
		$h[] = "$k: $v";
	}
	curl_setopt_array( $ch, array( CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $h, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20 ) );
	if ( null !== $body ) {
		curl_setopt( $ch, CURLOPT_POSTFIELDS, $body );
	}
	$out    = curl_exec( $ch );
	$status = (int) curl_getinfo( $ch, CURLINFO_RESPONSE_CODE );
	curl_close( $ch );
	return array( 'status' => $status, 'body' => (string) $out );
}

function paguara_e2e_flow(): Paguara_Payment_Flow {
	return new Paguara_Payment_Flow(
		new Paguara_Client( getenv( 'PAGUARA_API_URL' ), getenv( 'PAGUARA_SECRET_KEY' ), 'paguara_e2e_transport' ),
		getenv( 'PAGUARA_PUBLISHABLE_KEY' ),
		false,
		'http://tienda.local/?wc-api=paguara',
		'e2e' . getmypid()
	);
}
