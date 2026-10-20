import { createCipheriv, createDecipheriv } from 'node:crypto';
import { KeyProvider, LocalKeyProvider, parseHexKeys, providerFromEnv } from './kms';

/**
 * Cifrado por sobre de los secretos que la API guarda en la base y necesita en
 * claro: secretos de webhooks (`whsec_`), semillas de doble factor y llaves y
 * certificados de los bancos.
 *
 * Formato: `env:v1:<keyId>:<dek envuelta>:<iv>:<tag>:<cifrado>` (base64url). Cada
 * secreto tiene su propia DEK; el `purpose` va como contexto del KMS y como AAD
 * del AES-256-GCM.
 *
 * Se siguen leyendo los formatos anteriores: `enc:v1:` (AES-256-GCM directo con
 * SECRETS_ENCRYPTION_KEY, hasta el PR de KMS) y valores en claro (antes de
 * cifrar). `npm run secrets:rewrap` los pasa todos al formato y llave actuales.
 */
const ENV = 'env:v1:';
const LEGACY = 'enc:v1:';
const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

export class SecretVault {
  private readonly cache = new Map<string, { dek: Buffer; until: number }>();

  /**
   * @param provider el que cifra lo nuevo (null: desarrollo sin llave, se guarda en claro)
   * @param local llaves locales para leer lo cifrado con ellas (desarrollo, o datos de antes de pasar a AWS)
   */
  constructor(private readonly provider: KeyProvider | null, private readonly local: LocalKeyProvider | null = null,
    private readonly legacyKeys: Buffer[] = [], private readonly cacheMs = 10 * 60_000) {}

  get providerName(): string { return this.provider?.name ?? 'none'; }

  async seal(plain: string, purpose: string): Promise<string> {
    if (!this.provider) return plain;
    const context = { purpose };
    const dek = await this.provider.generateDataKey(context);
    const iv = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(12)));
    const c = createCipheriv('aes-256-gcm', dek.plaintext, iv);
    c.setAAD(Buffer.from(purpose));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    dek.plaintext.fill(0);
    return ENV + [Buffer.from(dek.keyId), dek.wrapped, iv, c.getAuthTag(), ct].map(b64).join(':');
  }

  async open(stored: string, purpose: string): Promise<string> {
    if (stored.startsWith(LEGACY)) return this.openLegacy(stored);
    if (!stored.startsWith(ENV)) return stored;
    const [keyIdB, wrapped, iv, tag, ct] = stored.slice(ENV.length).split(':').map(unb64);
    const keyId = keyIdB.toString('utf8');
    const context = { purpose };
    const cacheKey = `${keyId}|${purpose}|${b64(wrapped)}`;
    let dek = this.cache.get(cacheKey);
    if (!dek || dek.until < Date.now()) {
      const owner = keyId.startsWith('local:') ? this.local : this.provider?.name === 'aws' ? this.provider : null;
      if (!owner) throw new Error(`Hay secretos cifrados con ${keyId} y no está configurado su KMS`);
      dek = { dek: await owner.decryptDataKey(wrapped, keyId, context), until: Date.now() + this.cacheMs };
      if (this.cache.size > 1000) this.cache.clear();
      this.cache.set(cacheKey, dek);
    }
    const d = createDecipheriv('aes-256-gcm', dek.dek, iv);
    d.setAAD(Buffer.from(purpose));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }

  /** true si el valor ya está en el formato actual y con la llave activa (no hace falta volver a cifrarlo). */
  isCurrent(stored: string): boolean {
    if (!this.provider) return true;
    if (!stored.startsWith(ENV)) return false;
    return this.provider.isActive(unb64(stored.slice(ENV.length).split(':')[0]).toString('utf8'));
  }

  private openLegacy(stored: string): string {
    const [iv, tag, ct] = stored.slice(LEGACY.length).split(':').map(unb64);
    for (const key of this.legacyKeys) {
      try {
        const d = createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      } catch { /* prueba la siguiente llave */ }
    }
    throw new Error('Hay secretos cifrados (enc:v1) y ninguna llave de SECRETS_ENCRYPTION_KEY los abre');
  }
}

export function vaultFromEnv(env: NodeJS.ProcessEnv = process.env): SecretVault {
  const provider = providerFromEnv(env);
  const hex = /^[0-9a-f]{64}$/i.test(env.SECRETS_ENCRYPTION_KEY ?? '') ? [Buffer.from(env.SECRETS_ENCRYPTION_KEY!, 'hex')] : [];
  const legacyKeys = [...hex, ...parseHexKeys(env.SECRETS_ENCRYPTION_PREVIOUS_KEYS)];
  const local = provider instanceof LocalKeyProvider ? provider
    : legacyKeys.length ? new LocalKeyProvider(legacyKeys[0], legacyKeys.slice(1)) : null;
  return new SecretVault(provider, local, legacyKeys);
}

let current: SecretVault | null = null;

/** La bóveda del proceso, armada con las variables de entorno la primera vez que se usa. */
export function vault(): SecretVault {
  return (current ??= vaultFromEnv());
}

/** Solo pruebas: reemplaza la bóveda (null = volver a leer el entorno). */
export function setVaultForTests(v: SecretVault | null) {
  current = v;
}
