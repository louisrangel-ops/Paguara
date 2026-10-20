<?php
/**
 * Corre todas las pruebas del plugin: php tests/run.php
 * Sin PHPUnit a propósito: el plugin no tiene dependencias y las pruebas tampoco.
 */

require __DIR__ . '/bootstrap.php';

$GLOBALS['paguara_tests'] = array();
function test( string $name, callable $fn ) { $GLOBALS['paguara_tests'][ $name ] = $fn; }
function eq( $expected, $actual, string $msg = '' ) {
	if ( $expected !== $actual ) {
		throw new Exception( ( $msg ? "$msg: " : '' ) . 'esperaba ' . var_export( $expected, true ) . ', llegó ' . var_export( $actual, true ) );
	}
}
function throws( callable $fn, string $class, string $msg = '' ) {
	try { $fn(); } catch ( Throwable $e ) {
		if ( $e instanceof $class ) { return $e; }
		throw new Exception( "$msg: esperaba $class, llegó " . get_class( $e ) . ': ' . $e->getMessage() );
	}
	throw new Exception( "$msg: esperaba $class y no falló" );
}

foreach ( glob( __DIR__ . '/test-*.php' ) as $file ) {
	require $file;
}

$failed = 0;
foreach ( $GLOBALS['paguara_tests'] as $name => $fn ) {
	try {
		$fn();
		echo "ok - $name\n";
	} catch ( Throwable $e ) {
		$failed++;
		echo "not ok - $name\n  " . $e->getMessage() . "\n";
	}
}
$total = count( $GLOBALS['paguara_tests'] );
echo "# $total pruebas, $failed fallidas\n";
exit( $failed ? 1 : 0 );
