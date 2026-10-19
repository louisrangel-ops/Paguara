# DESIGN.md · Paguara

Fuente: el CSS real del sitio y del checkout de Paguara (`public/assets/site.css`, `public/site.html`, `public/checkout.html`). No sale de fintechrc.app: ese dominio estaba bloqueado en el entorno y es de otra marca (Fintech RC). Todos los valores están copiados tal cual. Al final está la línea de donde sale cada uno.

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
| Titular | Schibsted Grotesk 700 | Hero: `clamp(36px, 5.6vw, 60px)`, interlineado 1.04, tracking −0.03em. h1 a h3: interlineado 1.2, tracking −0.01em, `text-wrap: balance` |
| Interfaz | Schibsted Grotesk 400 a 600 | Cuerpo de 16px con interlineado 1.5. Botones y etiquetas en 600 |
| Cifras y código | Spline Sans Mono 500 y 600 | Montos, tasas, referencias y código, siempre con `tabular-nums`. Monto del boleto: 600, `clamp(26px, 7vw, 32px)` |

## Espaciado, radios y sombra

- **Espaciado:** 4, 6, 8, 12, 16 y 24 px son los valores de `gap` y `padding` más usados en el CSS. El contenido mide como máximo 1160px y el margen lateral mínimo es de 16px.
- **Radios:** `--radius` 12px (botón grande, aviso de tasa), 10px para botones y campos, 16px para tarjetas, 20px para recibos y la tarjeta de acceso, 14px para el boleto y 50% para los círculos.
- **Sombra:** `--shadow: 0 1px 2px rgba(23, 34, 29, 0.05), 0 8px 24px rgba(23, 34, 29, 0.06)`, solo en recibos, la tarjeta de acceso y el aviso flotante. En el tema oscuro baja a `0 1px 2px rgba(0, 0, 0, 0.3)`.
- **Alturas mínimas:** el botón normal mide 44px, el grande 52px y el pequeño (`.btn.sm`) y el de copiar 40px. El selector segmentado (`.seg button`) y el botón de mostrar contraseña miden 38px. Los campos miden 46px en el sitio y 48px en el checkout, y el botón de pagar del checkout 52px.

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

## Dónde está cada valor

Rutas relativas a `pasarela/` (son idénticas en el repo Paguara).

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
| Valores del tema oscuro | `public/assets/site.css:40-43` y `:51-54` |
| Pila `--font-ui` (Schibsted Grotesk) | `public/assets/site.css:32` |
| Pila `--font-figure` (Spline Sans Mono) | `public/assets/site.css:33` |
| Fuentes cargadas y sus pesos (Google Fonts) | `public/site.html:8`, `public/checkout.html:7` |
| Boleto como único elemento llamativo | `public/assets/site.css:1-3`; uso en `:221` y `:475` |
| `--radius` 12px y `--shadow` | `public/assets/site.css:34`, `:35` |
| Medidas del hero | `public/assets/site.css:198` |
| Botones (radio de 10px, 44px de alto) | `public/assets/site.css:88-90` |
| Alturas: `.btn.sm` y `.copy` 40px, `.seg button` 38px, contraseña 38px, campos 46px | `public/assets/site.css:106`, `:110`, `:407`, `:332`, `:124` |
| Checkout: campos 48px, botón de pagar 52px | `public/checkout.html:134`, `:142` |
| Foco de 3px en `--accent` | `public/assets/site.css:78` |
| Tarjeta 16px, recibo y acceso 20px con sombra | `public/assets/site.css:380`, `:206`, `:326` |
| Titulares 1 a 5 | `public/assets/site.js:555`, `:594`, `:615`, `:658`, `:672` |
