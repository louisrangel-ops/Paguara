/* Documentos legales de Paguara (#/legal/...).
   BORRADORES: deben revisarlos un abogado venezolano antes de publicarse. Lo que va entre corchetes
   [así] lo completa Paguara; la web lo resalta para que no se escape.
   Formato: cada sección es [título, bloques]; un bloque texto es un párrafo y un arreglo es una lista.
   Si cambias el texto de un documento que se acepta (accept: true), sube `version` aquí y LEGAL_VERSION en
   src/legal/legal-documents.ts: las cuentas nuevas quedan registradas con la versión nueva. */
(function () {
  'use strict';

  const ENTIDAD = '[Razón social de Paguara], RIF [J-00000000-0], con domicilio en [domicilio fiscal completo]';

  window.LEGAL = {
    version: '2026-10-20',
    updated: '20 de octubre de 2026',
    contact: { legal: '[correo legal]', privacy: '[correo de privacidad]', security: '[correo de seguridad]', support: '[correo de soporte]' },
    docs: [
      // -----------------------------------------------------------------------------------------
      {
        slug: 'terminos', title: 'Términos y condiciones', accept: true,
        summary: 'Las reglas para usar el sitio, el panel, la API y el checkout de Paguara.',
        sections: [
          ['1. Quiénes somos', [
            `Paguara es un servicio de procesamiento de pagos en línea operado por ${ENTIDAD} ("Paguara"). Estos términos regulan el uso del sitio web, el panel de comercios, la API, el checkout alojado, los links de pago y cualquier otro servicio que ofrezcamos (los "Servicios").`,
            'Para cualquier asunto relacionado con estos términos puedes escribir a [correo legal].',
          ]],
          ['2. Aceptación', [
            'Al crear una cuenta, marcar la casilla de aceptación o usar los Servicios, aceptas estos términos, el Acuerdo de comercio, la Política de privacidad y la Política de uso aceptable. Esa aceptación electrónica tiene la misma validez que una firma autógrafa conforme al Decreto con Fuerza de Ley sobre Mensajes de Datos y Firmas Electrónicas.',
            'Si actúas en nombre de una empresa, declaras que tienes facultades suficientes para obligarla.',
            'Guardamos constancia de la versión aceptada, la fecha y hora, la dirección IP y el navegador desde el que se aceptó.',
          ]],
          ['3. Quién usa Paguara', [
            'Hay dos tipos de usuarios:',
            [
              'Comercios: personas jurídicas o naturales con RIF vigente que abren una cuenta para cobrar a sus clientes. Su relación con Paguara se rige además por el Acuerdo de comercio.',
              'Pagadores: las personas que pagan a un comercio a través del checkout o de un link de pago. No necesitan cuenta.',
            ],
            'Paguara no vende los productos ni presta los servicios que los comercios ofrecen. El contrato de compraventa o de servicio es entre el comercio y el pagador, y el comercio responde por la calidad, la entrega, las garantías, la facturación y el precio de lo que vende, conforme a la normativa de protección al consumidor y de precios.',
          ]],
          ['4. Estado regulatorio', [
            'Paguara recibe los fondos de los pagadores y los liquida a los comercios. Esa actividad requiere autorización del Banco Central de Venezuela como proveedor no bancario de servicios de pago, o prestarse a través de una institución bancaria autorizada.',
            'Estado actual: [describir el estado de la autorización del BCV o el acuerdo con el banco aliado, con el número de providencia o resolución cuando exista]. Mientras ese estado no permita procesar dinero real, los Servicios solo funcionan en modo de prueba.',
          ]],
          ['5. Cuentas y seguridad', [
            [
              'La información que nos des debe ser verdadera, completa y estar al día.',
              'Eres responsable de guardar tus contraseñas y llaves secretas de API. Todo lo que se haga con ellas se considera hecho por ti hasta que nos avises que se vieron comprometidas.',
              'Debes avisarnos de inmediato a [correo de seguridad] si sospechas un acceso no autorizado.',
              'Podemos pedirte información adicional para verificar tu identidad o la de tu empresa en cualquier momento (ver la Política de prevención de LC/FT).',
            ],
          ]],
          ['6. Modo de prueba', [
            'El modo de prueba (sandbox) sirve para integrar y probar. Ahí no se mueve dinero real, los pagos se simulan y los datos pueden borrarse sin aviso. No uses datos reales de pagadores ni de tarjetas en el modo de prueba.',
          ]],
          ['7. Pagos, tasas y moneda', [
            [
              'Los montos en bolívares se calculan con la tasa oficial del BCV vigente en el momento del cobro. El checkout muestra la tasa aplicada y la congela por un tiempo limitado; si vence, se cotiza de nuevo.',
              'Cuando el pagador paga en divisas en efectivo, puede aplicarse el Impuesto a las Grandes Transacciones Financieras (IGTF), que se muestra antes de pagar.',
              'Un pago se considera completado solo cuando Paguara lo confirma. La captura de pantalla de una transferencia no es prueba de pago.',
            ],
          ]],
          ['8. Reclamos de pagadores', [
            'Si eres pagador y tienes un problema con lo que compraste, primero contacta al comercio: él es quien vende y quien puede devolverte el dinero.',
            'Si el problema es con el pago en sí (un cobro duplicado, un monto distinto al mostrado, un pago que no reconoces), escríbenos a [correo de soporte] con la referencia del pago que aparece en el comprobante. Respondemos en un plazo máximo de [10] días hábiles.',
            'Los reembolsos los ordena el comercio. Paguara los ejecuta por el mismo medio de pago cuando es posible y, si no, por el medio que acuerden el comercio y el pagador.',
          ]],
          ['9. Propiedad intelectual', [
            'El software, la marca Paguara, los logos, el diseño y la documentación pertenecen a Paguara o a sus licenciantes. Te damos una licencia limitada, no exclusiva e intransferible para usar los Servicios mientras tu cuenta esté vigente. No puedes copiar, descompilar ni revender los Servicios.',
            'Los ejemplos de código de la documentación puedes usarlos libremente en tu integración.',
          ]],
          ['10. Disponibilidad', [
            'Trabajamos para que los Servicios estén disponibles siempre, pero dependen de bancos, redes de pago, proveedores de internet y de energía que no controlamos. No garantizamos un funcionamiento ininterrumpido. Los mantenimientos programados se avisarán con anticipación cuando sea posible.',
          ]],
          ['11. Limitación de responsabilidad', [
            'En la medida que lo permita la ley, Paguara no responde por daños indirectos, lucro cesante ni pérdida de datos derivados del uso de los Servicios, ni por fallas de bancos, redes de pago o terceros. La responsabilidad total de Paguara frente a un comercio por cualquier reclamo se limita a las comisiones que ese comercio pagó en los [tres] meses anteriores al hecho que lo origina.',
            'Nada de esto limita la responsabilidad que la ley no permite limitar, como la que deriva de dolo o culpa grave.',
          ]],
          ['12. Suspensión y terminación', [
            'Podemos suspender o cerrar una cuenta si incumple estos términos o la Política de uso aceptable, si lo exige una autoridad competente, o si detectamos riesgo de fraude o de legitimación de capitales. El detalle para comercios, incluida la retención de fondos, está en el Acuerdo de comercio.',
            'Puedes cerrar tu cuenta cuando quieras escribiendo a [correo de soporte]. Las obligaciones pendientes (reembolsos, reclamos, comisiones) sobreviven al cierre.',
          ]],
          ['13. Cambios', [
            'Podemos modificar estos términos. Avisaremos de los cambios importantes por correo y en el panel con al menos [30] días de anticipación. Si sigues usando los Servicios después de esa fecha, aceptas la versión nueva; si no estás de acuerdo, puedes cerrar tu cuenta antes.',
          ]],
          ['14. Ley aplicable y jurisdicción', [
            'Estos términos se rigen por las leyes de la República Bolivariana de Venezuela. Las partes intentarán resolver cualquier controversia de forma amistosa durante [30] días. Si no lo logran, se someten a los tribunales competentes de [Caracas], sin perjuicio de los derechos que la ley reconozca a los consumidores.',
            'Las comunicaciones se harán por correo electrónico a la dirección registrada en la cuenta y se entienden recibidas al día hábil siguiente a su envío.',
          ]],
        ],
      },
      // -----------------------------------------------------------------------------------------
      {
        slug: 'comercios', title: 'Acuerdo de comercio', accept: true,
        summary: 'El contrato marco entre Paguara y cada comercio: comisiones, liquidación en bolívares, retenciones y contracargos.',
        sections: [
          ['1. Partes y objeto', [
            `Este acuerdo se celebra entre ${ENTIDAD} ("Paguara") y la persona que abre una cuenta de comercio (el "Comercio"). Paguara presta al Comercio el servicio de recibir pagos de sus clientes por los métodos habilitados, custodiarlos y liquidárselos en bolívares, descontando las comisiones pactadas.`,
            'Este acuerdo complementa los Términos y condiciones. Si hay contradicción, prevalece este acuerdo en lo que respecta a la relación con el Comercio, y un contrato particular firmado prevalece sobre ambos.',
          ]],
          ['2. Alta y verificación', [
            [
              'La cuenta nace en modo de prueba. Para cobrar dinero real, el Comercio debe completar la verificación: razón social, RIF, documento de su representante legal, domicilio, teléfono, actividad, y una cuenta bancaria en bolívares a nombre del Comercio.',
              'Paguara puede pedir documentos adicionales (acta constitutiva, registro mercantil, poder del representante, declaraciones de origen de fondos) y negar la activación sin expresar causa cuando el perfil de riesgo no sea aceptable.',
              'El Comercio debe avisar en un máximo de [5] días hábiles cualquier cambio en sus datos, accionistas, representantes o actividad.',
            ],
          ]],
          ['3. Métodos de pago por contrato', [
            'Cada método de pago (Pago Móvil, débito inmediato, tarjetas nacionales e internacionales, Zelle, Banesco Panamá, USDT, efectivo y los que se agreguen) se habilita al Comercio solo cuando Paguara lo aprueba y lo registra con la referencia de este acuerdo o de un anexo. Paguara puede deshabilitar un método si el banco o red que lo presta lo exige o si detecta riesgo.',
            'Métodos habilitados y condiciones particulares: [Anexo A, uno por comercio].',
          ]],
          ['4. Comisiones e impuestos', [
            [
              'El Comercio paga por cada pago exitoso la comisión publicada en la página de precios de Paguara para el método usado, o la negociada en el Anexo A. La comisión se descuenta del monto cobrado antes de liquidar.',
              'Las comisiones en bolívares causan IVA a la alícuota vigente (hoy 16 %). Paguara emite la factura de sus comisiones al Comercio.',
              'El Comercio es responsable de emitir su propia factura al pagador y de declarar y pagar sus impuestos. Cuando la ley obligue a Paguara a actuar como agente de retención o percepción (por ejemplo, del IGTF), Paguara retendrá y enterará el impuesto correspondiente.',
              'Paguara puede cambiar los precios publicados con [30] días de aviso. Los precios negociados del Anexo A se mantienen durante su vigencia.',
            ],
          ]],
          ['5. Tasa de cambio', [
            [
              'Los precios en divisas se convierten a bolívares con la tasa oficial del BCV vigente al momento del cobro; esa tasa queda congelada en el pago y no cambia después.',
              'Para pagos en USDT se usa la tasa USD/USDT [de la plataforma de intercambio que use Paguara, por confirmar]. Si no hay una tasa reciente, el pago no se procesa.',
            ],
          ]],
          ['6. Liquidación en bolívares', [
            [
              'Conforme a la normativa vigente, Paguara liquida al Comercio siempre en bolívares, en la cuenta bancaria verificada a nombre del Comercio. No se liquida a cuentas de terceros.',
              'Los fondos cobrados en divisas o en USDT se convierten a bolívares en el corte de liquidación, a la tasa de mercado del momento de la conversión. Sobre la porción convertida Paguara cobra un diferencial cambiario de [1,2 %, por confirmar], que se muestra por separado en el detalle de cada liquidación.',
              'Calendario de cortes: [indicar frecuencia y hora de corte, por ejemplo diario a las 16:00 en días hábiles bancarios]. Un pago entra en el corte cuando el banco o la red ya entregó los fondos a Paguara.',
              'Cada liquidación requiere la aprobación de dos personas autorizadas de Paguara antes de pagarse.',
            ],
          ]],
          ['7. Reservas y retenciones', [
            'Paguara puede retener total o parcialmente una liquidación, o constituir una reserva sobre los saldos del Comercio, cuando:',
            [
              'existan reclamos, contracargos o reembolsos pendientes, o una tasa de reclamos superior a la habitual;',
              'se detecte una actividad inusual o un posible incumplimiento de la Política de uso aceptable;',
              'lo ordene una autoridad competente, o lo exija la Política de prevención de LC/FT;',
              'el Comercio cierre su cuenta, durante [120] días para cubrir reclamos posteriores.',
            ],
            'Paguara informará al Comercio la causa y el plazo de la retención, salvo que la ley se lo impida. Los fondos retenidos no generan intereses.',
          ]],
          ['8. Reembolsos, reclamos y contracargos', [
            [
              'El Comercio puede ordenar reembolsos totales o parciales desde el panel o la API mientras tenga saldo suficiente. Las comisiones del pago original no se devuelven, salvo que el Anexo A diga otra cosa.',
              'Cuando un banco, emisor de tarjeta o red de pago revierta un pago (contracargo), Paguara descontará el monto y los cargos que imponga el tercero del saldo del Comercio, y le dará la oportunidad de presentar pruebas en el plazo que fije esa red.',
              'Si el saldo no alcanza, el Comercio debe pagar la diferencia en un plazo de [5] días hábiles desde que se le notifique. Paguara puede compensar esa deuda con liquidaciones futuras.',
            ],
          ]],
          ['9. Obligaciones del Comercio', [
            [
              'Vender solo bienes y servicios lícitos y que no estén en la lista de la Política de uso aceptable.',
              'Mostrar al pagador, antes de cobrar, su razón social, el precio total, la política de devoluciones y un medio de contacto.',
              'Cumplir la normativa de protección al consumidor, de precios, tributaria y de protección de datos.',
              'Usar los datos de pagadores solo para cumplir la venta y no guardar números completos de tarjeta, CVV ni claves de pago.',
              'Proteger sus llaves secretas de API, verificar la firma de los webhooks y no exponer llaves secretas en el navegador o en aplicaciones móviles.',
              'Colaborar con Paguara en las verificaciones de conocimiento del cliente y entregar la información que se le pida para investigar un pago.',
            ],
          ]],
          ['10. Modo de prueba', [
            'En el modo de prueba el Comercio puede usar todos los métodos para integrar. Ningún pago de prueba genera dinero, liquidaciones ni obligaciones. Paguara puede borrar los datos de prueba y limitar el uso del modo de prueba si se abusa de él.',
          ]],
          ['11. Datos personales', [
            'Respecto de los datos de los pagadores, el Comercio es el responsable y Paguara los trata por cuenta del Comercio para procesar el pago, y por cuenta propia cuando lo exigen la prevención de fraude y la normativa de LC/FT. El detalle está en la Política de privacidad.',
          ]],
          ['12. Confidencialidad', [
            'Cada parte guardará en confidencialidad la información no pública que reciba de la otra, durante la vigencia de este acuerdo y [3] años después, salvo que deba revelarla por orden de autoridad competente.',
          ]],
          ['13. Indemnidad', [
            'El Comercio mantendrá indemne a Paguara frente a reclamos de pagadores, autoridades o terceros que deriven de los productos o servicios que vende, del incumplimiento de este acuerdo o de la ley por parte del Comercio.',
          ]],
          ['14. Vigencia y terminación', [
            'Este acuerdo es de duración indefinida. El Comercio puede terminarlo en cualquier momento con aviso por escrito. Paguara puede terminarlo con [30] días de aviso, o de inmediato si el Comercio incumple este acuerdo, la Política de uso aceptable o la normativa de LC/FT. Tras la terminación, Paguara liquidará el saldo disponible menos las reservas del punto 7.',
          ]],
          ['15. Fuerza mayor', [
            'Ninguna parte responde por incumplimientos causados por hechos fuera de su control razonable, como fallas generalizadas de bancos o redes de pago, cortes eléctricos o de telecomunicaciones, desastres naturales o actos de autoridad.',
          ]],
          ['16. Ley y jurisdicción', [
            'Este acuerdo se rige por las leyes venezolanas. Las partes eligen como domicilio especial la ciudad de [Caracas] y se someten a la jurisdicción de sus tribunales competentes. [Evaluar con el abogado si se prefiere arbitraje en el Centro Empresarial de Conciliación y Arbitraje (CEDCA) o el Centro de Arbitraje de la Cámara de Caracas].',
          ]],
        ],
      },
      // -----------------------------------------------------------------------------------------
      {
        slug: 'privacidad', title: 'Política de privacidad', accept: true,
        summary: 'Qué datos tratamos de comercios y pagadores, para qué, con quién los compartimos y cómo ejercer tus derechos.',
        sections: [
          ['1. Responsable', [
            `El responsable del tratamiento es ${ENTIDAD}. Contacto para asuntos de privacidad: [correo de privacidad].`,
            'Venezuela no tiene todavía una ley general de protección de datos. Esta política aplica el derecho de toda persona a acceder, conocer y pedir la corrección o destrucción de sus datos (artículos 28 y 60 de la Constitución, conocido como habeas data), la Ley Especial contra los Delitos Informáticos, la Ley de Infogobierno en lo que corresponda, y buenas prácticas internacionales.',
          ]],
          ['2. Datos que tratamos', [
            'De los comercios y sus usuarios:',
            [
              'Identificación: nombre, correo, razón social, RIF, documento de identidad y datos del representante legal, domicilio y teléfono.',
              'Bancarios: banco y número de la cuenta en bolívares para liquidar.',
              'De uso: registros de acceso, dirección IP, navegador, acciones en el panel y en la API.',
              'De cumplimiento: documentos de verificación, información sobre accionistas y origen de fondos.',
            ],
            'De los pagadores:',
            [
              'Los que el método de pago exige: cédula, teléfono, banco, referencia de la transferencia, correo o dirección de billetera.',
              'Datos de tarjeta: se usan solo para autorizar el pago y se envían al procesador. Paguara no guarda el número completo de la tarjeta ni el CVV.',
              'Claves de pago (C2P, débito inmediato): se usan una vez para autorizar el pago y se descartan; nunca se guardan.',
              'Técnicos: dirección IP y navegador, para prevenir fraude.',
            ],
          ]],
          ['3. Para qué los usamos', [
            [
              'Prestar los Servicios: procesar pagos, liquidar a comercios, enviar comprobantes y webhooks.',
              'Cumplir obligaciones legales: conocimiento del cliente, prevención de legitimación de capitales y financiamiento al terrorismo, obligaciones tributarias y respuesta a autoridades competentes.',
              'Prevenir fraude y proteger la seguridad de los Servicios y de sus usuarios.',
              'Atender reclamos y soporte.',
              'Enviar avisos sobre la cuenta y cambios en los Servicios. Solo enviaremos mensajes comerciales con tu consentimiento, y puedes retirarlo en cualquier momento.',
            ],
            'No vendemos datos personales. No usamos los datos de los pagadores para publicidad.',
          ]],
          ['4. Con quién los compartimos', [
            [
              'Con el comercio al que le pagas, los datos necesarios para identificar el pago.',
              'Con bancos, redes de pago, procesadores de tarjetas y proveedores de intercambio de criptoactivos que ejecutan el pago.',
              'Con proveedores que nos prestan servicios (alojamiento, correo, almacenamiento), bajo contratos de confidencialidad: [lista de proveedores y país donde alojan los datos].',
              'Con autoridades competentes (BCV, Sudeban, SENIAT, UNIF, tribunales y Ministerio Público) cuando la ley lo exige.',
            ],
            'Algunos proveedores pueden estar fuera de Venezuela. En ese caso exigimos medidas de seguridad equivalentes a las de esta política.',
          ]],
          ['5. Cuánto tiempo los guardamos', [
            [
              'Los registros de transacciones y los de conocimiento del cliente se guardan por [10] años desde la operación o desde el cierre de la cuenta, o el plazo mayor que fije la normativa de LC/FT o tributaria.',
              'Los datos de la cuenta, mientras esté vigente y durante ese mismo plazo después del cierre.',
              'Los registros técnicos de acceso, [12] meses.',
              'Los datos del modo de prueba pueden borrarse en cualquier momento.',
            ],
            'El libro contable de Paguara es inmutable: los registros de pagos no se borran, pero al vencer los plazos se anonimizan los datos personales asociados cuando sea posible.',
          ]],
          ['6. Seguridad', [
            'Usamos conexiones cifradas (HTTPS), guardamos las contraseñas con un algoritmo de derivación de claves y solo el resumen criptográfico de las llaves de API y sesiones, ciframos los secretos de webhooks, separamos el panel interno de la red pública y exigimos la aprobación de dos personas para cada liquidación. Ningún sistema es infalible; si ocurre un incidente que afecte tus datos, te avisaremos sin demora indebida.',
          ]],
          ['7. Tus derechos', [
            'Puedes pedirnos, escribiendo a [correo de privacidad]:',
            [
              'acceso: saber qué datos tuyos tenemos y para qué;',
              'rectificación: corregir datos inexactos;',
              'supresión: borrar tus datos, salvo los que la ley nos obliga a conservar;',
              'oposición: dejar de recibir mensajes comerciales.',
            ],
            'Respondemos en un máximo de [15] días hábiles. Podemos pedirte que acredites tu identidad. Si eres pagador, en muchos casos el comercio es quien tiene la relación contigo y te redirigiremos a él.',
          ]],
          ['8. Menores de edad', [
            'Los Servicios para comercios no están dirigidos a menores de 18 años.',
          ]],
          ['9. Cookies', [
            'El uso de cookies y almacenamiento del navegador se explica en la Política de cookies.',
          ]],
          ['10. Cambios', [
            'Publicaremos cualquier cambio en esta página con su fecha. Si el cambio es importante, lo avisaremos por correo a los comercios.',
          ]],
        ],
      },
      // -----------------------------------------------------------------------------------------
      {
        slug: 'cookies', title: 'Política de cookies', accept: false,
        summary: 'Qué cookies y almacenamiento del navegador usamos. Hoy solo usamos los necesarios para que el sitio funcione.',
        sections: [
          ['1. Qué son', [
            'Una cookie es un pequeño archivo que un sitio guarda en tu navegador. El almacenamiento local (localStorage y sessionStorage) cumple una función parecida.',
          ]],
          ['2. Qué usamos', [
            'Paguara solo usa cookies y almacenamiento estrictamente necesarios. No usamos cookies de publicidad, de analítica ni de redes sociales.',
            { table: [['Nombre', 'Tipo', 'Para qué', 'Duración'], [
              ['sid', 'Cookie propia, necesaria', 'Mantener abierta tu sesión en el panel de comercios. Es HttpOnly y SameSite=Lax: el código de la página no puede leerla.', '14 días o hasta cerrar sesión'],
              ['paguara_cookies', 'localStorage, necesaria', 'Recordar que ya viste el aviso de cookies.', 'Hasta que borres los datos del navegador'],
              ['Token de operador', 'sessionStorage, necesaria', 'Solo en el panel interno de Paguara (personal autorizado).', 'Hasta cerrar la pestaña'],
            ]] },
          ]],
          ['3. Servicios de terceros', [
            [
              'Google Fonts: el sitio descarga sus tipografías de los servidores de Google, que reciben tu dirección IP. Google Fonts no instala cookies.',
              'cdnjs (Cloudflare): el checkout descarga de ahí la librería que dibuja el código QR para pagos en USDT.',
            ],
            '[Evaluar servir las tipografías y la librería del QR desde el propio dominio de Paguara para no enviar la IP a terceros.]',
          ]],
          ['4. Cómo controlarlas', [
            'Como solo usamos cookies necesarias, no pedimos consentimiento previo: sin ellas no podrías entrar al panel. Puedes bloquearlas o borrarlas desde la configuración de tu navegador; si lo haces, tendrás que iniciar sesión de nuevo.',
            'Si en el futuro agregamos cookies de analítica o publicidad, las activaremos solo después de que las aceptes, y podrás cambiar tu elección en cualquier momento.',
          ]],
        ],
      },
      // -----------------------------------------------------------------------------------------
      {
        slug: 'uso-aceptable', title: 'Uso aceptable', accept: true,
        summary: 'Qué no se puede vender ni hacer con Paguara.',
        sections: [
          ['1. Para qué es esta política', [
            'Algunos negocios y conductas están prohibidos por la ley o tienen un riesgo que bancos y redes de pago no aceptan. Si tu comercio vende algo de esta lista, Paguara no puede atenderte. Ante la duda, pregúntanos antes a [correo de soporte].',
          ]],
          ['2. Actividades prohibidas', [
            [
              'Cualquier actividad ilícita según la ley venezolana o la del país del pagador.',
              'Drogas, sustancias controladas y productos que aparenten serlo.',
              'Armas de fuego, municiones, explosivos y sus partes.',
              'Contenido sexual que involucre a menores, contenido sexual sin consentimiento y servicios sexuales.',
              'Juegos de azar, apuestas y loterías sin la licencia de la Comisión Nacional de Casinos, Salas de Bingo y Máquinas Traganíquel o del ente competente.',
              'Esquemas piramidales, multinivel sin producto real, inversiones con rendimiento garantizado y captación de dinero del público sin autorización.',
              'Compra y venta de divisas o criptoactivos como actividad principal sin la autorización de la autoridad competente (BCV, Sunacrip o el ente que haga sus veces).',
              'Productos falsificados o que violen derechos de propiedad intelectual.',
              'Venta de datos personales, bases de datos o cuentas de terceros.',
              'Medicamentos que exigen receta sin la autorización sanitaria correspondiente.',
              'Bienes robados, especies protegidas y productos cuya comercialización esté prohibida.',
              'Recaudación para organizaciones o personas incluidas en listas de sanciones nacionales o del Consejo de Seguridad de la ONU.',
            ],
          ]],
          ['3. Actividades que requieren aprobación previa', [
            [
              'Organizaciones sin fines de lucro y recaudación de donaciones.',
              'Viajes, pasajes y paquetes turísticos.',
              'Suscripciones y cobros recurrentes.',
              'Venta de alcohol y tabaco.',
              'Servicios financieros, de remesas o de cambio de divisas.',
              'Ventas de entradas y eventos futuros.',
            ],
          ]],
          ['4. Usos indebidos de la plataforma', [
            [
              'Procesar pagos de otro negocio a través de tu cuenta (agregación no autorizada).',
              'Simular ventas para obtener liquidez, dividir pagos para evadir límites o cobrar a tus propias tarjetas.',
              'Usar los Servicios para evadir controles fiscales, cambiarios o de prevención de LC/FT.',
              'Intentar vulnerar la seguridad de Paguara fuera de la Política de divulgación responsable, sobrecargar la API o eludir sus límites.',
              'Engañar a los pagadores sobre lo que venden, el precio o quién vende.',
            ],
          ]],
          ['5. Consecuencias', [
            'Si detectamos un incumplimiento podemos pedir aclaraciones, deshabilitar métodos de pago, retener fondos según el Acuerdo de comercio, suspender o cerrar la cuenta e informar a las autoridades cuando la ley lo exija.',
          ]],
        ],
      },
      // -----------------------------------------------------------------------------------------
      {
        slug: 'prevencion-lcft', title: 'Prevención de LC/FT', accept: false,
        summary: 'Cómo conocemos a nuestros clientes y prevenimos la legitimación de capitales y el financiamiento al terrorismo.',
        sections: [
          ['1. Compromiso', [
            'Paguara rechaza cualquier uso de sus Servicios para legitimar capitales, financiar el terrorismo o la proliferación de armas de destrucción masiva (LC/FT/FPADM). Esta política resume cómo lo prevenimos, conforme a la Ley Orgánica contra la Delincuencia Organizada y Financiamiento al Terrorismo, las normas que dicten la Sudeban y el BCV para el sector, y las recomendaciones del GAFI.',
            '[El abogado debe confirmar qué normas de la Sudeban y del BCV aplican a Paguara como sujeto obligado según su forma de autorización.]',
          ]],
          ['2. Oficial de cumplimiento', [
            'Paguara designa un Oficial de Cumplimiento, con autonomía y acceso directo a la junta directiva, responsable de este programa: [nombre del Oficial de Cumplimiento, correo de cumplimiento].',
          ]],
          ['3. Conocimiento del cliente', [
            'Antes de que un comercio cobre dinero real verificamos:',
            [
              'la existencia de la empresa (RIF, registro mercantil y acta constitutiva) y su actividad;',
              'la identidad del representante legal y de los beneficiarios finales con más del [10 %] de participación;',
              'que la cuenta bancaria de liquidación esté a nombre del comercio;',
              'que ninguno aparezca en listas de sanciones nacionales, del Consejo de Seguridad de la ONU u otras que Paguara determine, ni sea persona expuesta políticamente sin la debida diligencia reforzada.',
            ],
            'Según el riesgo del comercio aplicamos diligencia simplificada, estándar o reforzada, y actualizamos la información cada [12 a 36] meses según ese riesgo.',
          ]],
          ['4. Monitoreo', [
            'Revisamos las operaciones para detectar las que no coinciden con el perfil del comercio: montos o frecuencias inusuales, pagos fraccionados, muchos pagos de un mismo pagador, cambios bruscos de volumen o de método. Las liquidaciones exigen la aprobación de dos personas distintas.',
          ]],
          ['5. Reporte de actividades sospechosas', [
            'Cuando una operación resulte sospechosa, el Oficial de Cumplimiento la reporta a la Unidad Nacional de Inteligencia Financiera (UNIF) en los plazos legales. La ley prohíbe informar al cliente que fue reportado.',
          ]],
          ['6. Conservación de registros', [
            'Guardamos los registros de identificación y de operaciones por [10] años, o el plazo mayor que exija la ley, de forma que puedan entregarse a las autoridades competentes.',
          ]],
          ['7. Capacitación y auditoría', [
            'El personal de Paguara recibe capacitación en prevención de LC/FT/FPADM al ingresar y al menos una vez al año. El programa se audita de forma independiente cada [año].',
          ]],
          ['8. Colaboración del comercio', [
            'El comercio se obliga a entregar la información que Paguara le pida para estas verificaciones. Negarse, o entregar información falsa, es causa de suspensión y retención de fondos según el Acuerdo de comercio.',
          ]],
        ],
      },
      // -----------------------------------------------------------------------------------------
      {
        slug: 'seguridad', title: 'Seguridad y divulgación responsable', accept: false,
        summary: 'Cómo protegemos los pagos y cómo reportarnos una vulnerabilidad.',
        sections: [
          ['1. Cómo protegemos los pagos', [
            [
              'Todo el tráfico va cifrado con HTTPS.',
              'Las contraseñas se guardan con scrypt y de las llaves de API y sesiones solo guardamos su resumen criptográfico.',
              'Los secretos de webhooks se guardan cifrados y cada webhook va firmado para que el comercio verifique que vino de Paguara.',
              'El panel interno no está expuesto en la red pública, cada operador tiene su propio acceso y queda registro de lo que hace.',
              'Ninguna liquidación sale sin la aprobación de dos personas distintas.',
              'El libro contable es de doble partida e inmutable: un movimiento no se puede borrar ni editar, solo revertir con otro.',
              'Las claves de pago de los pagadores se usan una vez y no se guardan.',
            ],
          ]],
          ['2. Reportar una vulnerabilidad', [
            'Si encontraste una falla de seguridad, escríbenos a [correo de seguridad] con una descripción, los pasos para reproducirla y su impacto. Si puedes, cifra el mensaje con nuestra llave [publicar llave PGP o quitar esta frase].',
            'Nos comprometemos a:',
            [
              'confirmar que recibimos tu reporte en un máximo de [3] días hábiles;',
              'mantenerte al tanto mientras lo corregimos;',
              'darte crédito público, si lo deseas, cuando esté corregido;',
              'no iniciar acciones legales contra quien investigue de buena fe dentro de estas reglas.',
            ],
          ]],
          ['3. Reglas para investigar', [
            [
              'Usa solo cuentas del modo de prueba y tus propios datos.',
              'No accedas, modifiques ni borres datos de otros comercios o pagadores. Si llegas a ellos por accidente, detente y avísanos.',
              'No hagas pruebas de denegación de servicio, ingeniería social, spam ni ataques físicos.',
              'No publiques la falla hasta que la hayamos corregido o hayan pasado [90] días desde tu reporte, lo que ocurra primero.',
            ],
          ]],
          ['4. Fuera de alcance', [
            [
              'Reportes de herramientas automáticas sin una prueba de impacto real.',
              'Falta de cabeceras o configuraciones sin un ataque práctico.',
              'Fallas en servicios de terceros (bancos, redes de pago, proveedores) que no controlamos: repórtalas a ellos.',
            ],
          ]],
          ['5. Recompensas', [
            '[Indicar si Paguara ofrece recompensas por reportes y sus montos, o decir que por ahora no hay un programa de recompensas.]',
          ]],
        ],
      },
    ],
  };
})();
