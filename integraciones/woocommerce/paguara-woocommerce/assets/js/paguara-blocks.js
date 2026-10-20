/* Paguara en el checkout de bloques. Sin paso de compilación: usa los globales de WordPress. */
( function () {
	const settings = window.wc.wcSettings.getSetting( 'paguara_data', {} );
	const { createElement } = window.wp.element;
	const { decodeEntities } = window.wp.htmlEntities;
	const title = decodeEntities( settings.title || 'Paguara' );
	const Content = () => createElement( 'div', null, decodeEntities( settings.description || '' ) );

	window.wc.wcBlocksRegistry.registerPaymentMethod( {
		name: 'paguara',
		label: createElement( 'span', null, title ),
		ariaLabel: title,
		content: createElement( Content ),
		edit: createElement( Content ),
		canMakePayment: () => true,
		supports: { features: settings.supports || [ 'products' ] },
	} );
} )();
