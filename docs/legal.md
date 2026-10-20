# Documentos legales

Los textos legales de Paguara se publican como páginas del sitio y la cuenta de cada comercio guarda la constancia
de cuáles aceptó. **Todos son borradores**: un abogado venezolano debe revisarlos antes de publicarse, y lo que va
entre corchetes (`[Razón social de Paguara]`, `[J-00000000-0]`, `[correo legal]`…) lo completa Paguara.

## Documentos

| Documento | Ruta | ¿Se acepta al registrarse? | Contenido |
|---|---|---|---|
| Términos y condiciones | `#/legal/terminos` | Sí | Uso del sitio, panel, API y checkout; comercio frente a pagador; estado regulatorio; reclamos de pagadores; responsabilidad; ley y jurisdicción |
| Acuerdo de comercio | `#/legal/comercios` | Sí | Contrato marco: KYC, métodos por contrato (Anexo A), comisiones e IVA, tasa BCV congelada, liquidación solo en bolívares con diferencial al convertir, reservas y retenciones, reembolsos y contracargos, sandbox |
| Política de privacidad | `#/legal/privacidad` | Sí | Datos de comercios y pagadores, finalidades, terceros, plazos de conservación, seguridad, derechos (habeas data, art. 28 de la Constitución) |
| Uso aceptable | `#/legal/uso-aceptable` | Sí | Actividades prohibidas, las que requieren aprobación previa y usos indebidos de la plataforma |
| Política de cookies | `#/legal/cookies` | No (informativa) | Cookies y almacenamiento que usa la web, terceros (Google Fonts, cdnjs) |
| Prevención de LC/FT | `#/legal/prevencion-lcft` | No (informativa) | Oficial de cumplimiento, conocimiento del cliente, monitoreo, reportes a la UNIF, conservación de registros |
| Seguridad y divulgación responsable | `#/legal/seguridad` | No (informativa) | Medidas de seguridad y cómo reportar una vulnerabilidad |

`#/legal` muestra el índice. Cada página lleva el aviso de borrador y resalta los corchetes con `<mark class="fill">`.

## Dónde vive cada cosa

- **Textos**: `public/assets/legal.js` (`window.LEGAL`). Cada documento es `{slug, title, summary, accept, sections}`
  y cada sección `[título, bloques]`: un texto es un párrafo, un arreglo es una lista y `{table: [cabecera, filas]}`
  una tabla. Lo carga `public/site.html` antes de `site.js`.
- **Render**: `legalPage()` en `public/assets/site.js`, con el mismo armazón que la documentación (`.docs`).
- **Enlaces**: pie del sitio (Términos, Privacidad, Cookies, Seguridad, Todo lo legal), casilla del registro (abre
  en otra pestaña para no perder el formulario) y pie del checkout (Términos y Privacidad, en otra pestaña).
- **Aviso de cookies**: `cookieNotice()` en `site.js`. Como hoy solo hay cookies necesarias (`sid`) es un aviso
  informativo con "Entendido", que se recuerda en `localStorage` (`paguara_cookies = ok`). **Si algún día se agrega
  analítica o publicidad, el aviso debe pasar a pedir consentimiento antes de cargarla** y la política de cookies
  debe listarla.
- **security.txt**: `GET /.well-known/security.txt` (`src/legal/security-txt.controller.ts`, RFC 9116). Solo
  responde si `SECURITY_CONTACT` está definida (`mailto:` o `https://`); si no, 404. Incluye `Policy` y `Canonical`
  cuando hay `PUBLIC_BASE_URL`. `Expires` se calcula a un año.

## Constancia de aceptación

El registro (`POST /api/dashboard/signup`) exige `accept_terms: true` (el booleano, no el texto `"true"`); sin eso
responde 400 `signup_invalid` con `param: accept_terms` y no crea nada. En la misma transacción que crea el comercio
y el usuario se inserta una fila por documento aceptado en `dashboard.legal_acceptances`
(migración 011): `user_id`, `merchant_id`, `document`, `version`, `accepted_at`, `ip` y `user_agent` (≤ 400
caracteres). La tabla es append-only (trigger `ledger.tg_immutable`) y no admite dos filas para la misma persona,
documento y versión. La aceptación electrónica vale como firma según la Ley sobre Mensajes de Datos y Firmas
Electrónicas; esta tabla es la prueba.

Documentos que se aceptan: `ACCEPTED_AT_SIGNUP` en `src/legal/legal-documents.ts`.

## Cambiar un documento

1. Edita el texto en `public/assets/legal.js`.
2. Si el documento se acepta (`accept: true`) y el cambio es de fondo, sube `version` (fecha `AAAA-MM-DD`) en
   `legal.js` **y** `LEGAL_VERSION` en `src/legal/legal-documents.ts`. `test/unit/legal.test.ts` falla si no coinciden
   o si `ACCEPTED_AT_SIGNUP` no corresponde con los documentos marcados `accept`.
3. Actualiza también `updated` (la fecha que ve el lector) y anota el cambio en el [CHANGELOG](CHANGELOG.md).

## Pendiente

- Revisión por un abogado venezolano de todos los textos y llenado de los corchetes (razón social, RIF, domicilio,
  correos, plazos, tribunal o arbitraje, Oficial de Cumplimiento, proveedores y país de alojamiento).
- Confirmar la tasa USD/USDT y el diferencial de liquidación (hoy `FX_PAYOUT_SPREAD_BPS` = 120) que cita el acuerdo.
- Autorización del BCV como proveedor no bancario de servicios de pago (o banco aliado): el estado se declara en la
  sección 4 de los términos.
- Pedir a las cuentas existentes que acepten una versión nueva al entrar (hoy solo se registra al crear la cuenta).
- Anexo A por comercio (métodos y precios negociados) y cómo se firma; hoy el panel interno guarda solo `contract_ref`.
- Cumplimiento PCI DSS antes de recibir datos de tarjeta reales, o usar la página de pago del procesador.
- Servir las fuentes y `qrcodejs` desde el propio dominio para no enviar la IP del visitante a terceros.
