# Web: superficies, proceso de diseño y movimiento

La web de Paguara son cuatro superficies servidas por la misma API. Este documento dice dónde vive cada una,
cómo se diseñó la versión actual, las reglas del movimiento y cómo se verifica un cambio visual. Los colores,
tipos y medidas exactos están en [`DESIGN.md`](../DESIGN.md).

## Superficies

| Superficie | Ruta | Archivos | Quién la sirve |
|---|---|---|---|
| Sitio público, registro, documentación autenticada, páginas legales y panel del comercio | `GET /` (rutas en el hash: `#/`, `#/precios`, `#/docs`, `#/legal/...`, `#/entrar`, `#/registro`, `#/dashboard/...`) | `public/site.html`, `public/assets/site.css`, `public/assets/site.js`, `public/assets/site-demo.js`, `public/assets/legal.js` ([textos legales](legal.md)) | `src/dashboard/dashboard.controller.ts` (envuelve `site.html` y pone `window.__SERVER__ = true`) |
| Checkout alojado | `GET /checkout?pi=…&cs=…&pk=…` | `public/checkout.html` (CSS y JS en línea) | `src/checkout-page.controller.ts` |
| Panel interno | `GET /admin` | `public/admin.html` (CSS y JS en línea) | `src/admin-page.controller.ts` |
| Estáticos | `GET /assets/*` | `public/assets/` | `src/main.ts` (`useStaticAssets`, caché de 1 h) |

`#/docs` exige sesión de comercio: sin sesión el router redirige a `#/entrar?next=/docs` y la navegación pública no muestra enlaces a la documentación.\n\nSin `window.__SERVER__` el sitio corre en modo demostración (así se publica en Vercel, ver [despliegue](despliegue.md#vercel-web-en-modo-demostración)) contra `window.DemoApi` (`site-demo.js`), y el
checkout sin `pi`, `cs` y `pk` simula un pago. Así se publican las demos y se toman las capturas.

No hay paso de compilación: el CSS y el JS se sirven tal cual. Tampoco hay dependencias de frontend; la única
librería externa es `qrcodejs` en el checkout (para el QR de USDT).

## Proceso de diseño

El rediseño de octubre de 2026 siguió un proceso armado a partir de las guías que pidió luis
([frontend-design de Anthropic](https://github.com/anthropics/skills/tree/main/skills/frontend-design),
[impeccable.style](https://impeccable.style/), [figma-implement-design](https://github.com/openai/skills/tree/main/skills/.curated/figma-implement-design),
[webapp-testing](https://github.com/composio-community/awesome-codex-skills/tree/master/webapp-testing),
[designer-skills](https://github.com/Owl-Listener/designer-skills),
[theme-factory](https://github.com/composio-community/awesome-codex-skills/tree/master/theme-factory) y
[el artículo de Julian Oczkowski](https://medium.com/@julian.oczkowski/7-claude-code-design-skills-that-follow-a-real-design-process-b871b8673d05)).
Se usa igual para cualquier cambio visual que venga después:

1. **Criticar lo que hay antes de tocarlo** (designer-skills, "producto existente"): capturas de cada superficie
   en claro, oscuro y teléfono, y una lista de problemas por prioridad (impeccable: P0 a P3).
2. **Respetar el sistema existente** (figma-implement-design, impeccable, theme-factory): la paleta, el logo,
   los tokens de `site.css` y las clases que usa el JS no se reemplazan; se extienden. No se eligió un tema
   nuevo de theme-factory porque la marca ya tiene uno.
3. **Anclar el diseño en el oficio del producto** (frontend-design): el elemento característico de Paguara es el
   boleto con la tasa congelada, así que el hero lo pone en primer plano y el único momento animado cuenta esa
   historia. La estructura carga información (métodos agrupados por moneda, estados reales del pago), no adorno.
4. **Evitar los tics genéricos** (frontend-design, impeccable): sin etiquetas en mayúsculas, sin "eyebrows" sobre
   los titulares, sin rejillas de tarjetas idénticas, sin cifras inventadas, una sola acción principal por vista.
5. **Construir, luego revisar con el navegador real** (webapp-testing, design review del artículo): Playwright con
   Chromium, reconocimiento primero (esperar `networkidle`, capturar, leer selectores) y acción después.
6. **Verificar el piso de calidad**: axe-core sin violaciones WCAG 2.1 AA en claro y oscuro, foco visible,
   objetivos de 40 px o más, `prefers-reduced-motion`, peso medido contra el presupuesto.

## Movimiento

### Lo que se tomó de la referencia

luis pidió usar <https://huella-topaz.vercel.app/> como referencia de animaciones. El HTML, CSS y JS de esa
página **no se pudieron leer**: la política de red del entorno de desarrollo bloquea ese dominio (el proxy
devuelve 403). Lo que sí se pudo ver es su contenido renderizado, y de ahí se infieren las técnicas, sin
confirmar el código:

| Indicio en la página | Técnica probable | Qué hicimos en Paguara |
|---|---|---|
| La lista de servicios aparece dos veces seguidas | Cinta en bucle (marquee) con la lista duplicada | Cinta de rieles: CSS puro, `translateX(-50%)` sobre la lista duplicada, se pausa con el ratón |
| Los contadores muestran "0" antes de bajar | Contador que sube al entrar en pantalla | `[data-count]`: sube en 700 ms con `requestAnimationFrame` cuando su sección aparece |
| "Scroll" y "Seguí bajando" | Revelado por secciones al bajar | `[data-rv]` + `IntersectionObserver`, una sola vez por elemento |
| Mascota "Hacé clic en mí" y créditos de web 3D | Personaje 3D interactivo (probablemente WebGL) | **No se copió**: un motor 3D pesa cientos de KB y no tiene que ver con cobrar |

### Reglas

- **Solo CSS para animar, JS solo para decidir cuándo.** `site.js` pone la clase `.motion` en `<html>` si
  `prefers-reduced-motion` no es `reduce` y existe `IntersectionObserver`. Todas las reglas que esconden algo para
  animarlo cuelgan de `.motion`, así que sin JS o con movimiento reducido todo se ve quieto y completo.
- **Solo propiedades que no recalculan el layout:** `transform`, `opacity` y `clip-path`. La barra del split se
  "llena" con `clip-path` para no deformar el texto; la línea de estados se dibuja con `scaleX`.
- **Tres duraciones y una curva** (`--dur-1` 140 ms, `--dur-2` 260 ms, `--dur-3` 640 ms, `--ease-out`). Detalle en
  [`DESIGN.md`](../DESIGN.md#movimiento).
- **Un solo momento orquestado por página.** En la landing, la tasa BCV del boleto se mueve tres veces y se
  congela con un "sello" (el monto y el botón se recalculan con la misma aritmética half-even del servidor). En el
  checkout, el boleto hace el sello cada vez que llega una cotización nueva (no en cada tic del reloj) y la palomita
  de "Pago confirmado" se dibuja con `stroke-dashoffset`.
- **Lo que mejora sin JS lo hace el navegador:** el borde de la cabecera aparece al bajar con
  `animation-timeline: scroll()` (sin JS; donde no hay soporte el borde queda fijo) y el cambio entre páginas
  públicas usa la View Transitions API, solo si el navegador la tiene. El panel no la usa porque espera datos
  de la red y la transición congelaría la pantalla mientras tanto.
- **Los temporizadores mueren con la vista.** `later()` registra cada `setTimeout` en `state.cleanups` y
  `reveal()` desconecta su `IntersectionObserver` al cambiar de ruta.

Código: `public/assets/site.js` (bloque "Movimiento" y función `landing`), `public/assets/site.css`
(`.motion`, `.rails`, `.flow`, `.split-bar`, `::view-transition-*`), `public/checkout.html` (`.stamp`, `.done-mark`)
y `public/admin.html` (`.motion .card`, `.switch`).

### Presupuesto de peso

| Recurso | Límite | Medido después del rediseño |
|---|---|---|
| Sistema de movimiento (CSS + JS nuevos, comprimidos) | 3 KB | ≈ 2,5 KB |
| Librerías de animación | 0 | 0 |
| Archivos de fuentes por página | 2 | 2 (los mismos woff2 variables de antes) |
| CLS en la landing y el checkout | < 0,1 | 0,002 y 0,022 |

Pesos comprimidos con gzip, antes → después: `site.css` 8,5 → 10,5 KB, `site.js` 38,3 → 39,9 KB,
`checkout.html` 15,2 → 16,1 KB, `admin.html` 5,3 → 6,8 KB. La landing completa (HTML, CSS, JS y demo) pasó de
56,6 a 60,2 KB comprimidos. Se miden con `gzip -9c archivo | wc -c` y, en el navegador, sumando
`encodedDataLength` de los eventos `Network.loadingFinished` de Chrome DevTools Protocol.

## Cómo verificar un cambio visual

Capturas de referencia del rediseño en [`docs/capturas/web/rediseno/`](capturas/web/rediseno/) (hero, hero mientras cotiza y congelado, landing oscura en teléfono, panel, checkout con Pago Móvil y panel interno).

1. Servir `public/` como lo hacen los controladores (o levantar la API con `docker compose up`) y abrir el sitio en
   modo demostración.
2. Con Playwright y Chromium, capturar cada superficie a 1440 × 900 y 390 × 844, en claro y oscuro, con
   `reducedMotion: 'reduce'` para que las capturas sean estables. Para el panel, entrar por `#/entrar` con
   cualquier correo y contraseña (la demo acepta todo).
3. Inyectar `axe-core` y correr las reglas `wcag2a`, `wcag2aa`, `wcag21a` y `wcag21aa` en cada pantalla, en los
   dos temas. El resultado esperado es cero violaciones.
4. Con `reducedMotion: 'no-preference'`, bajar por la landing y comprobar que ningún `[data-rv]` quede con
   `opacity` distinta de 1.
5. Correr `npm run typecheck`, `npm test` y `npm run test:integration`: el rediseño no toca la API, pero el CI
   los exige.
