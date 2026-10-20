# DESIGN.md · Paguara

Fuente: el CSS real del sitio, del checkout y del panel interno de Paguara (`public/assets/site.css`, `public/site.html`, `public/checkout.html`, `public/admin.html`). No sale de fintechrc.app: ese dominio estaba bloqueado en el entorno y es de otra marca (Fintech RC). Todos los valores están copiados tal cual. Al final está la línea de donde sale cada uno.

## Idea en una línea

Papel claro, verde profundo y un único boleto amarillo: el de la tasa congelada. Todo lo demás se queda callado para que el monto se lea primero.

## Colores (tema claro)

| Nombre | Token | Hex | Rol | Se combina con |
|---|---|---|---|---|
| Papel | `--paper` | `#F5F6F1` | Fondo de página | Tinta |
| Superficie | `--surface` | `#FFFFFF` | Tarjetas, campos, recibos | Tinta y borde `--line` `#D9DED6` |
| Tinta | `--ink` | `#17221D` | Texto principal, aviso flotante (invertido sobre Papel) | Papel, Superficie |
| Gris pizarra | `--muted` | `#56635C` | Texto secundario, entradillas, pistas | Papel, Superficie |
| Verde Paguara | `--accent` | `#1D5E47` | Botón primario, enlaces, foco, gráfico | Texto `--accent-ink` `#FFFFFF`; fondo suave `--accent-soft` `#E3EFE9` |
| Boleto | `--ticket` | `#F4C95D` | Solo la tasa congelada y el boleto del monto | Texto `--ticket-ink` `#17221D` |

Estados (no son marca, son funcionales): éxito `--ok` `#17663F`, error `--bad` `#A8231B`.

Tema oscuro: los mismos roles con otros valores, por ejemplo Papel `#101613`, Tinta `#E8EEE9`, Verde `#6FC7A1` con texto `#0E1512` y Boleto `#E7B94C` con texto `#15120A`. Se activa con `prefers-color-scheme: dark` o con `data-theme="dark"`.

## Tipografía

Las fuentes que se cargan son **Schibsted Grotesk** (400, 500, 600 y 700) y **Spline Sans Mono** (500 y 600), las dos desde Google Fonts. "Segoe UI", system-ui y Menlo son solo respaldo.

| Rol | Fuente | Uso y medidas |
|---|---|---|
| Titular | Schibsted Grotesk 700 | Hero: `clamp(40px, 5.6vw, 72px)`, interlineado 1.0, tracking −0.035em. Títulos de sección: `clamp(30px, 4vw, 48px)`, interlineado 1.08, tracking −0.03em. h1 a h3: interlineado 1.2, tracking −0.01em, `text-wrap: balance` |
| Interfaz | Schibsted Grotesk 400 a 600 | Cuerpo de 16px con interlineado 1.5. Botones y etiquetas en 600 |
| Cifras y código | Spline Sans Mono 500 y 600 | Montos, tasas, referencias y código, siempre con `tabular-nums`. Monto del boleto: 600, `clamp(26px, 7vw, 32px)`. Código de moneda en la landing (`Bs`, `USD`, `USDT`): 600, `clamp(36px, 4vw, 52px)`, en Verde |

Las dos familias se piden a Google Fonts como rango variable (`wght@400..700` y `wght@500..600`): es el mismo archivo woff2 que antes, con una URL más corta. El panel interno ahora también carga la mono para ids y cifras.

## Espaciado, radios y sombra

- **Espaciado:** 4, 6, 8, 12, 16 y 24 px son los valores de `gap` y `padding` más usados en el CSS. El contenido mide como máximo 1160px y el margen lateral mínimo es de 16px.
- **Ritmo vertical de la landing:** cada sección abre con `clamp(64px, 9vw, 112px)` de aire; el hero, con `clamp(40px, 7vw, 88px)`. El contenido del panel mide como máximo 1240px y el del panel interno 1120px.
- **Radios:** `--radius` 12px (botón grande, aviso de tasa), 10px para botones y campos, 16px para tarjetas y bloques de código, 20px para recibos y la tarjeta de acceso, 24px para la demostración del split, 28px para el mostrador verde del hero y la banda final, 14px para el boleto y 50% para los círculos.
- **Sombra:** `--shadow: 0 1px 2px rgba(23, 34, 29, 0.05), 0 8px 24px rgba(23, 34, 29, 0.06)` en la tarjeta de acceso y el aviso flotante. `--shadow-lift: 0 1px 2px rgba(23, 34, 29, 0.06), 0 24px 48px -12px rgba(23, 34, 29, 0.18)` solo en lo que "flota" sobre la página: el recibo del hero, los bloques de código y la tarjeta del checkout. En el tema oscuro bajan a `0 1px 2px rgba(0, 0, 0, 0.3)` y `0 1px 2px rgba(0, 0, 0, 0.4), 0 24px 48px -12px rgba(0, 0, 0, 0.5)`.
- **Alturas mínimas:** el botón normal mide 44px, el grande 52px y el pequeño (`.btn.sm`) y el de copiar 40px. El selector segmentado (`.seg button`) y el botón de mostrar contraseña miden 38px. Los campos miden 46px en el sitio y 48px en el checkout, y el botón de pagar del checkout 52px.

## Composición

- **Hero:** titular grande a la izquierda (1,3 fr) y, a la derecha (0,7 fr), el recibo del checkout girado −1° sobre un "mostrador" de Verde Paguara. Al pasar el ratón el recibo se endereza. Es la única pieza con color de fondo fuerte arriba del pliegue.
- **Cinta de rieles:** debajo del hero, los nueve rieles con su moneda en mono. Es decorativa (`aria-hidden`): la lista accesible está en la sección de métodos.
- **Métodos agrupados por moneda:** tres columnas (Bs, USD, USDT) con un filete de 2px en Tinta arriba y el código de la moneda en grande. Sin tarjetas: la agrupación dice en qué moneda cobra el comercio. El checkout agrupa igual ("En bolívares", "En dólares", "En USDT").
- **Cómo funciona:** los cuatro estados reales del PaymentIntent (`requires_payment_method`, `processing`, `succeeded`, `settled`) sobre una línea. En el teléfono la línea es vertical.
- **Checkout en pantallas anchas (≥ 960px):** dos columnas. A la izquierda el comercio, el total y el boleto; a la derecha la elección del método y el formulario. En el teléfono sigue siendo una sola columna, con el boleto justo antes del formulario.
- **Panel interno:** barra superior con la marca y la etiqueta "Interno", encabezados de tabla fijos, contador de solicitudes pendientes y los checkboxes con forma de interruptor (siguen siendo `<input type="checkbox">`).

## Movimiento

Reglas completas, presupuesto de peso y el porqué en [`docs/web.md`](docs/web.md#movimiento).

| Token | Valor | Uso |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | Todas las entradas y respuestas |
| `--dur-1` | 140ms | Respuesta a una acción: hover, presión de botón (`scale(0.97)`) |
| `--dur-2` | 260ms | Cambio de estado: interruptores, diálogos, entrada de una vista del panel |
| `--dur-3` | 640ms | Revelado de secciones y la entrada del hero |

- **Siempre** anima solo `transform`, `opacity` y `clip-path`. **Nunca** animes `width`, `height`, `top` ni `margin`.
- **Siempre** deja el contenido visible sin JavaScript y con `prefers-reduced-motion: reduce`: las reglas de movimiento cuelgan de la clase `.motion` que pone el JS solo cuando el usuario no pidió reducir movimiento.
- **Siempre** un solo momento orquestado por página: en la landing, la tasa que se mueve y se congela en el boleto; en el checkout, el "sello" del boleto con cada cotización nueva y la palomita que se dibuja al confirmar.
- **Nunca** cargues una librería de animación. El presupuesto del sistema de movimiento es de 3 KB comprimidos entre CSS y JS.

## Voz y tono

Titulares reales del sitio:

1. "Cobra en bolívares, dólares y USDT con una sola integración."
2. "Todos los métodos que usan tus clientes"
3. "Una API pensada para montos exactos"
4. "Liquida en la mezcla que te sirve"
5. "Prueba la integración hoy mismo"

Reglas que salen de esos titulares:

- **Siempre** tutea al comercio y abre con un verbo de acción: cobra, liquida, prueba.
- **Siempre** nombra las monedas y los rieles por su nombre (bolívares, dólares, USDT, Pago Móvil). **Nunca** escribas "múltiples soluciones de pago".
- **Siempre** promete algo que se pueda comprobar: "el monto que ve es el que cobras", "nada de céntimos perdidos por redondeo". **Nunca** uses superlativos como "el mejor" o "revolucionario".
- Los titulares de sección van en tipo oración y sin punto final. Solo el hero lleva punto.

## Reglas duras

- **Siempre** pon las cifras en Spline Sans Mono con `tabular-nums`. **Nunca** uses la mono para la prosa.
- **Siempre** reserva el amarillo Boleto para la tasa congelada y el monto. **Nunca** lo uses en botones, insignias ni fondos decorativos.
- **Siempre** usa Verde Paguara para la acción principal, y solo una por vista. Las secundarias van en `ghost` o `quiet`.
- **Siempre** marca el foco visible con un contorno de 3px en `--accent`. **Nunca** quites el contorno sin dar un reemplazo.
- **Nunca** uses `#000` ni `#FFF` como fondo de página: el fondo es Papel `#F5F6F1` (o `#101613` en el tema oscuro).
- **Nunca** pongas sombra en las tarjetas del panel: llevan borde de 1px en `--line`.
- **Nunca** uses números inventados como prueba social (comercios, volumen, reseñas). Los únicos números de la landing salen del producto: 10 métodos, 3 monedas, la tabla de precios y el ejemplo calculado con la aritmética del servidor.

## Dónde está cada valor

Rutas relativas a la raíz del repo Paguara.

| Valor | Archivo:línea |
|---|---|
| Papel `#F5F6F1` | `public/assets/site.css:5` |
| Superficie `#FFFFFF` | `public/assets/site.css:6` |
| Tinta `#17221D` | `public/assets/site.css:8` |
| Gris pizarra `#56635C` | `public/assets/site.css:9` |
| Borde `#D9DED6` | `public/assets/site.css:10` |
| Verde `#1D5E47`, texto `#FFFFFF`, suave `#E3EFE9` | `public/assets/site.css:12`, `:14`, `:15` |
| Boleto `#F4C95D`, texto `#17221D` | `public/assets/site.css:16`, `:17` |
| Éxito `#17663F`, error `#A8231B` | `public/assets/site.css:19`, `:21` |
| Valores del tema oscuro | `public/assets/site.css:44-56` y `:57-67` |
| Pila `--font-ui` (Schibsted Grotesk) | `public/assets/site.css:32` |
| Pila `--font-figure` (Spline Sans Mono) | `public/assets/site.css:33` |
| Fuentes cargadas (Google Fonts, rango variable) | `public/site.html:8`, `public/checkout.html:7`, `public/admin.html:5` |
| `--radius` 12px, `--shadow` y `--shadow-lift` | `public/assets/site.css:34`, `:35`, `:36` |
| Tokens de movimiento `--ease-out`, `--dur-1` a `--dur-3` | `public/assets/site.css:38-41` |
| Botones (radio de 10px, 44px de alto, presión) | `public/assets/site.css:96-104` |
| Alturas: `.btn.sm` y `.copy` 40px, `.seg button` 38px, contraseña 38px, campos 46px | `public/assets/site.css:117`, `:120`, `:502`, `:423`, `:133` |
| Checkout: campos 48px, botón de pagar 52px | `public/checkout.html:157`, `:165` |
| Foco de 3px en `--accent` | `public/assets/site.css:86` |
| Cabecera translúcida con borde al bajar | `public/assets/site.css:186-195` |
| Medidas del hero | `public/assets/site.css:222` |
| Recibo del hero y su mostrador verde | `public/assets/site.css:229-233` |
| Boleto como único elemento llamativo | `public/assets/site.css:251`; en el panel `.frozen` `:573` |
| Cinta de rieles | `public/assets/site.css:270-282` |
| Revelado al bajar (`.motion [data-rv]`) | `public/assets/site.css:284-286` |
| Columnas por moneda | `public/assets/site.css:296` |
| Línea de estados | `public/assets/site.css:311` |
| Barra del split con `clip-path` | `public/assets/site.css:363-365` |
| Fundido entre páginas (View Transitions) | `public/assets/site.css:383` |
| Tarjeta 16px | `public/assets/site.css:475` |
| Detector de movimiento, revelado y contador | `public/assets/site.js:227-251` |
| Momento orquestado de la tasa | `public/assets/site.js` (función `landing`) |
| Titulares 1 a 5 | `public/assets/site.js:598`, `:658`, `:696`, `:739`, `:753` |
