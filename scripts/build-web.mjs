// Genera la web estática en modo demostración (dist-web/) para hospedarla sin la API, por ejemplo en Vercel.
// Envuelve las páginas igual que los controladores de Nest, pero sin window.__SERVER__: el sitio usa
// site-demo.js y el checkout simula un pago. El panel interno (/admin) no se incluye porque necesita la API.
// Uso: node scripts/build-web.mjs (la salida es siempre dist-web/: así el borrado previo nunca toca el repo)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-web');
const page = (file) => '<!doctype html><html lang="es"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>'
  + readFileSync(join(root, 'public', file), 'utf8')
  + '</body></html>';

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'checkout'), { recursive: true });
cpSync(join(root, 'public', 'assets'), join(out, 'assets'), { recursive: true });
writeFileSync(join(out, 'index.html'), page('site.html'));
writeFileSync(join(out, 'checkout', 'index.html'), page('checkout.html'));
// Los links y pagos de ejemplo abren el checkout de este mismo despliegue
const demo = join(out, 'assets', 'site-demo.js');
const src = readFileSync(demo, 'utf8');
const patched = src.replace(/const DEMO_CHECKOUT_URL = '[^']*';/, "const DEMO_CHECKOUT_URL = '/checkout';");
if (patched === src) throw new Error('No encontré DEMO_CHECKOUT_URL en site-demo.js');
writeFileSync(demo, patched);
console.log('Web estática en ' + out);
