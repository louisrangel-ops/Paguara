<?php
/**
 * Verificación de la firma de los webhooks de Paguara (docs/webhooks.md):
 *   Webhook-Signature: t=<unix>,v1=<hex>
 *   v1 = HMAC_SHA256(whsec, "<t>.<cuerpo crudo>")
 */

defined( 'ABSPATH' ) || exit;

final class Paguara_Signature {

	/** Antigüedad máxima aceptada de `t`, en segundos (contra reenvíos de un evento capturado). */
	const TOLERANCE = 300;

	public static function verify( string $header, string $body, string $secret, ?int $now = null, int $tolerance = self::TOLERANCE ): bool {
		if ( '' === $secret || '' === $header ) {
			return false;
		}
		$t      = null;
		$hashes = array();
		foreach ( explode( ',', $header ) as $part ) {
			$kv = explode( '=', trim( $part ), 2 );
			if ( 2 !== count( $kv ) ) {
				continue;
			}
			if ( 't' === $kv[0] && ctype_digit( $kv[1] ) ) {
				$t = (int) $kv[1];
			} elseif ( 'v1' === $kv[0] ) {
				$hashes[] = $kv[1];
			}
		}
		if ( null === $t || ! $hashes ) {
			return false;
		}
		$now = $now ?? time();
		if ( abs( $now - $t ) > $tolerance ) {
			return false;
		}
		$expected = hash_hmac( 'sha256', $t . '.' . $body, $secret );
		foreach ( $hashes as $hash ) {
			if ( hash_equals( $expected, $hash ) ) {
				return true;
			}
		}
		return false;
	}

	/** Para pruebas: arma el encabezado igual que signPayload en src/webhooks/webhooks.service.ts. */
	public static function header( string $body, string $secret, int $t ): string {
		return 't=' . $t . ',v1=' . hash_hmac( 'sha256', $t . '.' . $body, $secret );
	}
}
