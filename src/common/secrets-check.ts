/**
 * Al arrancar un despliegue público (LIVEMODE=true o cookies Secure) se exige un
 * INTERNAL_API_TOKEN propio (los valores de las plantillas versionadas son públicos
 * en el repo y darían acceso a /internal) y el gestor de llaves que cifra los
 * secretos en la base. En producción además: un KMS de verdad (no la llave local),
 * puerto interno separado y doble aprobación de liquidaciones. Que no queden rieles de prueba lo revisa app.module (buildRails).
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
  // Gestor de llaves: AWS KMS (o equivalente) en producción; la llave local solo en sandbox y desarrollo
  const kms = env.KMS_PROVIDER ?? 'local';
  const hexKey = (v: string | undefined) => /^[0-9a-f]{64}$/i.test(v ?? '');
  if (kms === 'aws') {
    if (!env.KMS_KEY_ID) problems.push('KMS_PROVIDER=aws exige KMS_KEY_ID (ARN, id o alias de la llave en AWS KMS)');
    if (env.SECRETS_ENCRYPTION_KEY && !hexKey(env.SECRETS_ENCRYPTION_KEY)) problems.push('SECRETS_ENCRYPTION_KEY, si se define, debe tener 64 caracteres hex');
  } else if (kms !== 'local') {
    problems.push(`KMS_PROVIDER desconocido: ${kms} (local o aws)`);
  } else if (!hexKey(env.SECRETS_ENCRYPTION_KEY)) {
    problems.push('SECRETS_ENCRYPTION_KEY debe tener 64 caracteres hex (openssl rand -hex 32): es la llave maestra local que cifra los secretos en la base');
  }
  if ((env.SECRETS_ENCRYPTION_PREVIOUS_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean).some((k) => !hexKey(k))) {
    problems.push('SECRETS_ENCRYPTION_PREVIOUS_KEYS: cada llave, separada por coma, debe tener 64 caracteres hex');
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
    if (kms === 'local') problems.push('KMS_PROVIDER=local no se permite con LIVEMODE=true: las llaves y certificados de los bancos van en un KMS (KMS_PROVIDER=aws y KMS_KEY_ID)');
  }
  return problems;
}
