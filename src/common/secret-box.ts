import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado en reposo de secretos que la API necesita en claro para firmar
 * (los `whsec_` de los webhooks). AES-256-GCM con la llave de
 * SECRETS_ENCRYPTION_KEY (64 caracteres hex, `openssl rand -hex 32`). En
 * producción esa variable vive en el gestor de secretos del hosting (o un KMS),
 * nunca en la base: quien roba un respaldo de la base no puede firmar webhooks.
 *
 * Formato guardado: `enc:v1:<iv>:<tag>:<cifrado>` en base64url. Un valor sin el
 * prefijo es de antes del cifrado y se devuelve tal cual. Sin llave (solo en
 * local: el chequeo de arranque la exige al desplegar) se guarda en claro.
 */
const PREFIX = 'enc:v1:';

function key(): Buffer | null {
  const hex = process.env.SECRETS_ENCRYPTION_KEY ?? '';
  return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
}

export function sealSecret(plain: string): string {
  const k = key();
  if (!k) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join(':');
}

export function openSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const k = key();
  if (!k) throw new Error('Hay secretos cifrados y falta SECRETS_ENCRYPTION_KEY');
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
