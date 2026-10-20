import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';

/**
 * Gestor de llaves (KMS). La llave maestra nunca sale del proveedor: la API le
 * pide una llave de datos (DEK) por cada secreto, cifra el secreto con ella y
 * guarda la DEK envuelta (cifrada por la llave maestra) al lado. Para leer, el
 * proveedor desenvuelve la DEK. Es el cifrado por sobre (envelope) de AWS KMS,
 * Google Cloud KMS o Vault Transit.
 *
 * El contexto (`purpose`) va atado a la DEK y al dato: un secreto copiado a otra
 * fila con otro propósito no se abre.
 */
export interface DataKey {
  plaintext: Buffer;
  wrapped: Buffer;
  keyId: string;
}

export interface KeyProvider {
  readonly name: 'local' | 'aws';
  /** Llave que cifra lo nuevo (para saber si un dato quedó con una llave vieja). */
  readonly activeKeyId: string;
  /** true si `keyId` (el guardado junto al dato) es la llave que cifra lo nuevo. */
  isActive(keyId: string): boolean;
  generateDataKey(context: Record<string, string>): Promise<DataKey>;
  decryptDataKey(wrapped: Buffer, keyId: string, context: Record<string, string>): Promise<Buffer>;
}

const HEX_KEY = /^[0-9a-f]{64}$/i;
const aad = (context: Record<string, string>) => Buffer.from(JSON.stringify(Object.entries(context).sort(([a], [b]) => a.localeCompare(b))));

export const localKeyId = (key: Buffer) => `local:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;

/**
 * Proveedor local: la llave maestra es SECRETS_ENCRYPTION_KEY (64 hex). Solo para
 * desarrollo y sandbox; con LIVEMODE=true la API no arranca con él. Las llaves
 * anteriores (SECRETS_ENCRYPTION_PREVIOUS_KEYS, separadas por coma) solo
 * descifran, para poder rotar sin perder lo guardado.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly name = 'local' as const;
  readonly activeKeyId: string;
  private readonly keys = new Map<string, Buffer>();

  constructor(active: Buffer, previous: Buffer[] = []) {
    this.activeKeyId = localKeyId(active);
    for (const k of [active, ...previous]) this.keys.set(localKeyId(k), k);
  }

  isActive(keyId: string): boolean {
    return keyId === this.activeKeyId;
  }

  async generateDataKey(context: Record<string, string>): Promise<DataKey> {
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    c.setAAD(aad(context));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return { plaintext, wrapped: Buffer.concat([iv, c.getAuthTag(), ct]), keyId: this.activeKeyId };
  }

  async decryptDataKey(wrapped: Buffer, keyId: string, context: Record<string, string>): Promise<Buffer> {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`No está la llave maestra ${keyId}: agrégala a SECRETS_ENCRYPTION_PREVIOUS_KEYS`);
    const d = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, 12));
    d.setAAD(aad(context));
    d.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  }
}

/** Lo mínimo del cliente de AWS que se usa; las pruebas pasan uno falso. */
export interface KmsClientLike {
  send(command: GenerateDataKeyCommand | DecryptCommand): Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array; KeyId?: string }>;
}

/**
 * AWS KMS: la llave maestra (KMS_KEY_ID, ARN o alias) vive en AWS y la API solo
 * tiene permiso de GenerateDataKey y Decrypt. AWS rota la llave cada año sin que
 * cambie su id, y cada uso queda en CloudTrail.
 */
export class AwsKmsProvider implements KeyProvider {
  readonly name = 'aws' as const;

  constructor(readonly activeKeyId: string, private readonly client: KmsClientLike = new KMSClient({})) {}

  /**
   * AWS guarda el ARN; KMS_KEY_ID puede ser alias, id o ARN. Con alias no se sabe
   * a qué llave apunta sin consultarlo, así que todo lo de AWS cuenta como vigente
   * (AWS rota el material de la llave sin cambiarle el id).
   */
  isActive(keyId: string): boolean {
    if (keyId.startsWith('local:')) return false;
    return this.activeKeyId.startsWith('alias/') || keyId === this.activeKeyId || keyId.endsWith(`/${this.activeKeyId}`);
  }

  async generateDataKey(context: Record<string, string>): Promise<DataKey> {
    const out = await this.client.send(new GenerateDataKeyCommand({ KeyId: this.activeKeyId, KeySpec: 'AES_256', EncryptionContext: context }));
    if (!out.Plaintext || !out.CiphertextBlob) throw new Error('KMS no devolvió la llave de datos');
    return { plaintext: Buffer.from(out.Plaintext), wrapped: Buffer.from(out.CiphertextBlob), keyId: out.KeyId ?? this.activeKeyId };
  }

  async decryptDataKey(wrapped: Buffer, keyId: string, context: Record<string, string>): Promise<Buffer> {
    const out = await this.client.send(new DecryptCommand({ CiphertextBlob: wrapped, KeyId: keyId, EncryptionContext: context }));
    if (!out.Plaintext) throw new Error('KMS no devolvió la llave de datos');
    return Buffer.from(out.Plaintext);
  }
}

export function parseHexKeys(list: string | undefined): Buffer[] {
  return (list ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((k) => {
    if (!HEX_KEY.test(k)) throw new Error('SECRETS_ENCRYPTION_PREVIOUS_KEYS: cada llave debe tener 64 caracteres hex');
    return Buffer.from(k, 'hex');
  });
}

/** Proveedor según el entorno. null = desarrollo sin llave (los secretos quedan en claro; desplegado no arranca así). */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider | null {
  const kind = env.KMS_PROVIDER ?? 'local';
  if (kind === 'aws') {
    if (!env.KMS_KEY_ID) throw new Error('KMS_PROVIDER=aws exige KMS_KEY_ID');
    return new AwsKmsProvider(env.KMS_KEY_ID);
  }
  if (kind !== 'local') throw new Error(`KMS_PROVIDER desconocido: ${kind} (local o aws)`);
  const active = env.SECRETS_ENCRYPTION_KEY ?? '';
  if (!HEX_KEY.test(active)) return null;
  return new LocalKeyProvider(Buffer.from(active, 'hex'), parseHexKeys(env.SECRETS_ENCRYPTION_PREVIOUS_KEYS));
}
