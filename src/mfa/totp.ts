import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238): el código de 6 dígitos que muestran Google Authenticator,
 * Microsoft Authenticator, 1Password o Authy. HMAC-SHA1, pasos de 30 s; se
 * acepta un paso antes y uno después por diferencias de reloj.
 */
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Semilla base32 inválida');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** Semilla nueva de 160 bits (lo que recomienda el RFC 4226), en base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, '0');
}

export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

/**
 * Devuelve el paso que coincide (para no aceptar el mismo código dos veces) o
 * null. `afterStep`: el último paso ya usado; solo valen pasos posteriores.
 */
export function verifyTotp(secret: string, code: string, opts: { nowMs?: number; afterStep?: number | null; window?: number } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(opts.nowMs);
  const window = opts.window ?? 1;
  for (let step = now - window; step <= now + window; step++) {
    if (opts.afterStep != null && step <= opts.afterStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** Enlace que leen las apps autenticadoras (el QR lo codifica tal cual). */
export function otpauthUrl(secret: string, account: string, issuer = 'Paguara'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ---- Códigos de respaldo ---------------------------------------------------
// 10 códigos de 10 caracteres (xxxxx-xxxxx, sin letras que se confunden): ~50 bits cada uno

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 10;

export function newRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: n }, () => {
    const bytes = randomBytes(10);
    const s = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  const s = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return s.length === 10 ? `${s.slice(0, 5)}-${s.slice(5)}` : '';
}

export const hashRecoveryCode = (code: string) => createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
