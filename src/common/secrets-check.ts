/**
 * Al arrancar un despliegue público (LIVEMODE=true o cookies Secure) se exige un
 * INTERNAL_API_TOKEN propio: los valores de las plantillas versionadas son públicos
 * en el repo y darían acceso a /internal (KYC, tesorería, llaves de cualquier comercio).
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
  return problems;
}
