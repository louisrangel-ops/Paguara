/**
 * Datos iniciales para desarrollo, usando la API como lo haría una persona:
 * un usuario del panel con su comercio y un par de llaves de prueba (creadas
 * desde el panel, con su sesión), y el primer maestro del panel interno si aún
 * no existe. Se puede repetir: si el usuario ya existe no lo vuelve a crear, pero
 * igual crea el maestro si falta (p. ej. en una base que se subió a la migración 010).
 */
const APP_URL = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.INTERNAL_API_TOKEN;
const EMAIL = process.env.SEED_EMAIL ?? 'dev@paguara.test';
const PASSWORD = process.env.SEED_PASSWORD ?? 'paguara-dev-123';

async function post(path: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${APP_URL}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any, cookie: res.headers.get('set-cookie') ?? '' };
}

// Primer maestro del panel interno (/admin): solo se puede crear una vez con el token de sistema
async function bootstrapMaster(token: string) {
  const master = await post('/internal/operators', { name: 'maestro-dev', role: 'master' }, { 'x-internal-token': token });
  if (master.status < 300) console.log(`Maestro:   ${master.body.token}   (entra a /admin con este token; no se vuelve a mostrar)`);
  else if (master.status === 403) console.log('Maestro:   ya existe; pídele un token al maestro actual');
  else throw new Error(`operators → ${master.status} ${JSON.stringify(master.body)}`);
}

async function main() {
  if (process.env.LIVEMODE === 'true') throw new Error('LIVEMODE=true: el seed es solo para sandbox');
  if (!TOKEN) throw new Error('INTERNAL_API_TOKEN no está definido');
  // La clave por defecto está en el repo: en un entorno público cualquiera entraría al panel.
  if (process.env.COOKIE_SECURE !== 'false' && !process.env.SEED_PASSWORD) {
    throw new Error('Entorno público (COOKIE_SECURE no es false): define SEED_PASSWORD con una clave propia');
  }

  const signup = await post('/api/dashboard/signup',
    { name: 'Desarrollo', email: EMAIL, password: PASSWORD, business_name: 'Tienda de Pruebas', rif: 'J-00000001-0', accept_terms: true },
    { 'x-requested-with': 'fetch' });
  // El comercio se inserta antes que el usuario, así que una repetición choca por el RIF o por el correo.
  if (signup.status === 400 && ['email', 'rif'].includes(signup.body.error?.param)) {
    console.log(`El comercio de prueba ya existe (${EMAIL}); no se creó de nuevo. Entra al panel o crea llaves desde ahí.`);
    await bootstrapMaster(TOKEN);
    return;
  }
  if (signup.status >= 300) throw new Error(`signup → ${signup.status} ${JSON.stringify(signup.body)}`);

  const merchantId: string = signup.body.merchant.id;
  const session = { 'x-requested-with': 'fetch', cookie: signup.cookie.split(';')[0] };
  const sk = await post('/api/dashboard/api_keys', { kind: 'secret' }, session);
  const pk = await post('/api/dashboard/api_keys', { kind: 'publishable' }, session);
  if (sk.status >= 300 || pk.status >= 300) throw new Error(`api_keys → ${JSON.stringify([sk.body, pk.body])}`);

  console.log(`Panel:     ${process.env.PUBLIC_BASE_URL ?? APP_URL}/#/entrar  (${EMAIL} / ${PASSWORD})`);
  console.log(`Comercio:  ${merchantId}`);
  console.log(`Secreta:   ${sk.body.key}   (no se vuelve a mostrar)`);
  console.log(`Pública:   ${pk.body.key}`);
  await bootstrapMaster(TOKEN);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });

export {};
