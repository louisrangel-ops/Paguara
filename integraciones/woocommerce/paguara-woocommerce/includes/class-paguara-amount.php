<?php
/**
 * Montos: WooCommerce guarda decimales ("12.50"); Paguara recibe enteros en
 * unidades mínimas como texto ("1250"). Todo con texto, nada de float.
 */

defined( 'ABSPATH' ) || exit;

final class Paguara_Amount {

	/** Monedas que acepta la API y sus decimales (igual que CURRENCY_EXPONENT en src/common/money.ts). */
	const EXPONENT = array(
		'VES'  => 2,
		'USD'  => 2,
		'EUR'  => 2,
		'USDT' => 6,
	);

	public static function is_supported( string $currency ): bool {
		return isset( self::EXPONENT[ strtoupper( $currency ) ] );
	}

	/**
	 * "12.5" en USD → "1250". Falla si el total no es un decimal positivo o trae
	 * más decimales de los que tiene la moneda (no se redondea dinero en silencio).
	 *
	 * @throws InvalidArgumentException
	 */
	public static function to_minor( string $total, string $currency ): string {
		$currency = strtoupper( $currency );
		if ( ! self::is_supported( $currency ) ) {
			throw new InvalidArgumentException( "Moneda no soportada por Paguara: $currency" );
		}
		$total = trim( $total );
		if ( ! preg_match( '/^(\d+)(?:\.(\d+))?$/', $total, $m ) ) {
			throw new InvalidArgumentException( "Total inválido: $total" );
		}
		$exp  = self::EXPONENT[ $currency ];
		$frac = rtrim( $m[2] ?? '', '0' );
		if ( strlen( $frac ) > $exp ) {
			throw new InvalidArgumentException( "El total $total tiene más de $exp decimales para $currency" );
		}
		$minor = ltrim( $m[1] . str_pad( $frac, $exp, '0' ), '0' );
		if ( '' === $minor ) {
			throw new InvalidArgumentException( 'El total debe ser mayor que cero' );
		}
		return $minor;
	}
}
