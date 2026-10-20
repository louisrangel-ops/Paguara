/**
 * Al arrancar un despliegue público (LIVEMODE=true o cookies Secure) se exige un
 * INTERNAL_API_TOKEN propio (los valores de las plantillas versionadas son públicos
 * en el repo y darían acceso a /internal) y la llave que cifra los secretos de
 * webhooks. En producción además: puerto interno separado y doble aprobación de
 * liquidaciones. Que no queden rieles de prueba lo revisa app.module (buildRails).
 */
const PLACEHOLDER_TOKENS = new Set(['cambia-esto', 'dev-internal-token']);
export const MIN_INTERNAL_TOKEN_LENGTH = 32;

export function deployedConfigProblems(env: NodeJS.ProcessEnv): string[] {
  const deployed = env.LIVEMODE === 'true' || env.COOKIE_SECURE !== 'false';
  if (!deployed) return [];
  const token = env.INTERNAL_API_TOKEN ?? '';
  const problems: string[] = [];
  if (PLACEHOLDER_TOKENS.has(token)) problems.push('INTERNAL_API_TOKEN es el valor de ejemplo del repo');
  else if (token.length < MIN_INTERNAL_TOKEN_LENGTH) {
    problems.push(`INTERNAL_API_TOKEN debe tener al menos ${MIN_INTERNAL_TOKEN_LENGTH} caracteres (p. ej. openssl rand -hex 32)`);
  }
  if (env.LIVEMODE === 'true' && env.COOKIE_SECURE === 'false') problems.push('COOKIE_SECURE=false no se permite con LIVEMODE=true');
  if (!/^[0-9a-f]{64}$/i.test(env.SECRETS_ENCRYPTION_KEY ?? '')) {
    problems.push('SECRETS_ENCRYPTION_KEY debe tener 64 caracteres hex (openssl rand -hex 32): cifra los secretos de webhooks en la base');
  }
  if (env.LIVEMODE === 'true') {
    // En producción, /internal y /admin no pueden quedar en el puerto público
    const port = Number(env.PORT ?? 3000);
    const internal = Number(env.INTERNAL_PORT);
    if (!Number.isInteger(internal) || internal <= 0 || internal === port) {
      problems.push('INTERNAL_PORT es obligatorio con LIVEMODE=true y distinto de PORT: /internal y /admin solo se sirven ahí, en la red privada');
    }
    const approvals = Number(env.PAYOUT_APPROVALS_REQUIRED ?? 2);
    if (!Number.isInteger(approvals) || approvals < 2) problems.push('PAYOUT_APPROVALS_REQUIRED debe ser 2 o más con LIVEMODE=true: ninguna liquidación sale con una sola persona');
  }
  return problems;
}
