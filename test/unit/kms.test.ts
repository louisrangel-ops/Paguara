import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { AwsKmsProvider, KmsClientLike, LocalKeyProvider, localKeyId, providerFromEnv } from '../../src/secrets/kms';
import { SecretVault, vaultFromEnv } from '../../src/secrets/vault';

const k1 = Buffer.alloc(32, 1);
const k2 = Buffer.alloc(32, 2);

test('bóveda local: cifra por sobre, cada secreto con su propia DEK, y lo abre de vuelta', async () => {
  const p = new LocalKeyProvider(k1);
  const v = new SecretVault(p, p);
  const a = await v.seal('whsec_abc', 'webhook_secret');
  assert.match(a, /^env:v1:/);
  assert.ok(!a.includes('whsec_abc'));
  assert.notEqual(await v.seal('whsec_abc', 'webhook_secret'), a, 'otra DEK y otro IV cada vez');
  assert.equal(await v.open(a, 'webhook_secret'), 'whsec_abc');
  assert.ok(v.isCurrent(a));
});

test('bóveda: el propósito va atado al dato (copiar un secreto a otra columna no sirve)', async () => {
  const p = new LocalKeyProvider(k1);
  const v = new SecretVault(p, p, [], 0);
  const sealed = await v.seal('JBSWY3DPEHPK3PXP', 'mfa:usr_1');
  await assert.rejects(v.open(sealed, 'mfa:usr_2'));
  const parts = sealed.split(':');
  parts[6] = Buffer.from('otro').toString('base64url');
  await assert.rejects(v.open(parts.join(':'), 'mfa:usr_1'), 'un cifrado alterado no se abre');
});

test('rotación local: la llave vieja solo descifra y lo nuevo sale con la activa', async () => {
  const old = new SecretVault(new LocalKeyProvider(k1), new LocalKeyProvider(k1));
  const sealed = await old.seal('cert-pem', 'rail:ves_c2p:client_cert');
  const rotated = new LocalKeyProvider(k2, [k1]);
  const v = new SecretVault(rotated, rotated);
  assert.equal(await v.open(sealed, 'rail:ves_c2p:client_cert'), 'cert-pem');
  assert.equal(v.isCurrent(sealed), false, 'hay que volver a cifrarlo');
  const again = await v.seal('cert-pem', 'rail:ves_c2p:client_cert');
  assert.ok(v.isCurrent(again));
  const onlyNew = new LocalKeyProvider(k2);
  await assert.rejects(new SecretVault(onlyNew, onlyNew).open(sealed, 'rail:ves_c2p:client_cert'), /SECRETS_ENCRYPTION_PREVIOUS_KEYS/);
});

test('formatos anteriores: enc:v1 con SECRETS_ENCRYPTION_KEY y valores en claro se siguen leyendo', async () => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k1, iv);
  const ct = Buffer.concat([c.update('whsec_viejo', 'utf8'), c.final()]);
  const legacy = 'enc:v1:' + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join(':');
  const v = vaultFromEnv({ SECRETS_ENCRYPTION_KEY: k2.toString('hex'), SECRETS_ENCRYPTION_PREVIOUS_KEYS: k1.toString('hex') });
  assert.equal(await v.open(legacy, 'webhook_secret'), 'whsec_viejo');
  assert.equal(await v.open('whsec_en_claro', 'webhook_secret'), 'whsec_en_claro');
  assert.equal(v.isCurrent(legacy), false);
  await assert.rejects(vaultFromEnv({ SECRETS_ENCRYPTION_KEY: k2.toString('hex') }).open(legacy, 'webhook_secret'));
});

test('sin llave (solo desarrollo) se guarda en claro', async () => {
  const v = vaultFromEnv({});
  assert.equal(v.providerName, 'none');
  assert.equal(await v.seal('x', 'p'), 'x');
});

/** KMS falso con el mismo contrato que AWS: la llave maestra nunca sale de él. */
function fakeAws(): KmsClientLike & { calls: string[] } {
  const master = randomBytes(32);
  const calls: string[] = [];
  const local = new LocalKeyProvider(master);
  return {
    calls,
    async send(cmd) {
      const ctx = cmd.input.EncryptionContext ?? {};
      if (cmd instanceof GenerateDataKeyCommand) {
        calls.push('GenerateDataKey');
        const dk = await local.generateDataKey(ctx);
        return { Plaintext: dk.plaintext, CiphertextBlob: dk.wrapped, KeyId: 'arn:aws:kms:us-east-1:111:key/abc' };
      }
      calls.push('Decrypt');
      const input = (cmd as DecryptCommand).input;
      return { Plaintext: await local.decryptDataKey(Buffer.from(input.CiphertextBlob!), localKeyId(master), ctx) };
    },
  };
}

test('AWS KMS: pide una DEK por secreto, la desenvuelve con Decrypt y la guarda un rato en memoria', async () => {
  const client = fakeAws();
  const aws = new AwsKmsProvider('alias/paguara', client);
  const v = new SecretVault(aws, null);
  const sealed = await v.seal('contenido de una llave privada de prueba', 'rail:ves_c2p:private_key');
  assert.equal(await v.open(sealed, 'rail:ves_c2p:private_key'), 'contenido de una llave privada de prueba');
  assert.equal(await v.open(sealed, 'rail:ves_c2p:private_key'), 'contenido de una llave privada de prueba');
  assert.deepEqual(client.calls, ['GenerateDataKey', 'Decrypt'], 'la segunda lectura usa la DEK en memoria');
  assert.ok(v.isCurrent(sealed), 'con alias, lo cifrado en AWS cuenta como vigente: rewrap no lo repite');
  assert.ok(new AwsKmsProvider('abc').isActive('arn:aws:kms:us-east-1:111:key/abc'));
  assert.equal(new AwsKmsProvider('otra').isActive('arn:aws:kms:us-east-1:111:key/abc'), false);
});

test('AWS KMS: lo cifrado antes con la llave local se sigue abriendo al migrar', async () => {
  const local = new LocalKeyProvider(k1);
  const sealed = await new SecretVault(local, local).seal('whsec_x', 'webhook_secret');
  const v = new SecretVault(new AwsKmsProvider('alias/paguara', fakeAws()), local);
  assert.equal(await v.open(sealed, 'webhook_secret'), 'whsec_x');
  assert.equal(v.isCurrent(sealed), false);
});

test('proveedor según el entorno', () => {
  assert.equal(providerFromEnv({}), null);
  assert.equal(providerFromEnv({ SECRETS_ENCRYPTION_KEY: k1.toString('hex') })?.name, 'local');
  assert.equal(providerFromEnv({ KMS_PROVIDER: 'aws', KMS_KEY_ID: 'alias/paguara', AWS_REGION: 'us-east-1' })?.name, 'aws');
  assert.throws(() => providerFromEnv({ KMS_PROVIDER: 'aws' }), /KMS_KEY_ID/);
  assert.throws(() => providerFromEnv({ KMS_PROVIDER: 'vault' }), /desconocido/);
});
