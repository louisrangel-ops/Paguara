import { vault } from '../secrets/vault';

/**
 * Secretos de webhooks (`whsec_`): la API los necesita en claro para firmar, así
 * que se guardan cifrados por sobre con el KMS (`src/secrets/vault.ts`). Quien
 * roba un respaldo de la base no puede firmar webhooks. Se siguen leyendo los
 * guardados antes en `enc:v1:` o en claro.
 */
const PURPOSE = 'webhook_secret';

export function sealSecret(plain: string): Promise<string> {
  return vault().seal(plain, PURPOSE);
}

export function openSecret(stored: string): Promise<string> {
  return vault().open(stored, PURPOSE);
}
