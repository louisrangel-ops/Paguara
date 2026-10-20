import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { Pool } from 'pg';
import { ApiError } from '../common/errors';
import { PG_POOL, withTransaction } from '../database/database';
import { vault } from './vault';

export type RailCredentialKind = 'api_key' | 'password' | 'certificate' | 'private_key' | 'pkcs12';
const KINDS: RailCredentialKind[] = ['api_key', 'password', 'certificate', 'private_key', 'pkcs12'];
const SLUG = /^[a-z0-9_]{2,40}$/;
const MAX_BYTES = 64 * 1024;
const purpose = (rail: string, name: string) => `rail:${rail}:${name}`;

/**
 * Llaves, claves y certificados que entrega cada banco (API key del C2P, usuario
 * y clave del web service, certificado TLS cliente y su llave privada, .p12).
 * Se guardan cifrados por sobre con el KMS y la base exige el formato cifrado:
 * nunca quedan en claro, tampoco en desarrollo. Se ven una sola vez, al cargarlos;
 * después solo los conectores de los rieles los leen (`reveal`), y cada versión
 * nueva retira la anterior sin borrarla.
 */
@Injectable()
export class RailCredentialsService {
  private readonly log = new Logger(RailCredentialsService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async put(input: { rail?: unknown; name?: unknown; kind?: unknown; value?: unknown }, actor: string) {
    const rail = String(input.rail ?? '');
    const name = String(input.name ?? '');
    const kind = input.kind as RailCredentialKind;
    const value = typeof input.value === 'string' ? input.value : '';
    if (!SLUG.test(rail)) throw new ApiError(400, 'rail_invalid', 'rail: minúsculas, números y _ (p. ej. ves_c2p)');
    if (!SLUG.test(name)) throw new ApiError(400, 'name_invalid', 'name: minúsculas, números y _ (p. ej. client_cert)');
    if (!KINDS.includes(kind)) throw new ApiError(400, 'kind_invalid', `kind debe ser uno de ${KINDS.join(', ')}`);
    if (!value || Buffer.byteLength(value) > MAX_BYTES) throw new ApiError(400, 'value_invalid', 'value es obligatorio y de hasta 64 KB (un .p12 va en base64)');
    const expiresAt = kind === 'certificate' ? certificateExpiry(value) : null;
    if (kind === 'private_key' && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
      throw new ApiError(400, 'value_invalid', 'La llave privada debe venir en PEM (-----BEGIN PRIVATE KEY-----)');
    }
    if (kind === 'pkcs12' && !/^[A-Za-z0-9+/=\s]+$/.test(value)) throw new ApiError(400, 'value_invalid', 'El .p12 va en base64');
    if (vault().providerName === 'none') {
      throw new ApiError(503, 'kms_unavailable', 'No hay gestor de llaves configurado (KMS_PROVIDER o SECRETS_ENCRYPTION_KEY): los secretos de los bancos no se guardan en claro');
    }
    const sealed = await vault().seal(value, purpose(rail, name));
    const fingerprint = createHash('sha256').update(value).digest('hex');
    return withTransaction(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rail_cred:${rail}:${name}`]);
      const { rows: [prev] } = await c.query<{ version: number; fingerprint: string }>(
        `SELECT version, fingerprint FROM platform.rail_credentials WHERE rail = $1 AND name = $2 ORDER BY version DESC LIMIT 1`, [rail, name]);
      await c.query('UPDATE platform.rail_credentials SET retired_at = now() WHERE rail = $1 AND name = $2 AND retired_at IS NULL', [rail, name]);
      const id = `rcred_${randomBytes(10).toString('hex')}`;
      const version = (prev?.version ?? 0) + 1;
      await c.query(
        `INSERT INTO platform.rail_credentials (id, rail, name, kind, version, sealed, fingerprint, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, rail, name, kind, version, sealed, fingerprint, expiresAt, actor]);
      this.log.log(`Secreto ${rail}/${name} v${version} cargado por ${actor}`);
      return { id, rail, name, kind, version, fingerprint: fingerprint.slice(0, 16), expires_at: expiresAt, same_as_previous: prev?.fingerprint === fingerprint };
    });
  }

  /** Metadatos de los vigentes; el valor nunca sale por aquí. */
  async list() {
    const { rows } = await this.pool.query(
      `SELECT id, rail, name, kind, version, left(fingerprint, 16) AS fingerprint, expires_at, created_by, created_at
         FROM platform.rail_credentials WHERE retired_at IS NULL ORDER BY rail, name`);
    return rows;
  }

  /** Solo para los conectores de los rieles, nunca para una respuesta HTTP. */
  async reveal(rail: string, name: string): Promise<string> {
    const { rows } = await this.pool.query<{ sealed: string }>(
      'SELECT sealed FROM platform.rail_credentials WHERE rail = $1 AND name = $2 AND retired_at IS NULL', [rail, name]);
    if (!rows[0]) throw new Error(`Falta el secreto ${rail}/${name}: cárgalo en el panel interno`);
    return vault().open(rows[0].sealed, purpose(rail, name));
  }

  async retire(rail: string, name: string, actor: string) {
    const res = await this.pool.query('UPDATE platform.rail_credentials SET retired_at = now() WHERE rail = $1 AND name = $2 AND retired_at IS NULL', [rail, name]);
    if (res.rowCount === 0) throw new ApiError(404, 'resource_missing', `No hay un secreto vigente ${rail}/${name}`);
    this.log.log(`Secreto ${rail}/${name} retirado por ${actor}`);
    return { rail, name, retired: true };
  }

  /** Certificados que vencen en menos de `days` días (alerta diaria). */
  async expiringCertificates(days = 30) {
    const { rows } = await this.pool.query<{ rail: string; name: string; expires_at: Date }>(
      `SELECT rail, name, expires_at FROM platform.rail_credentials
        WHERE retired_at IS NULL AND expires_at IS NOT NULL AND expires_at < now() + make_interval(days => $1) ORDER BY expires_at`, [days]);
    return rows;
  }
}

function certificateExpiry(pem: string): Date {
  try {
    return new Date(new X509Certificate(pem).validTo);
  } catch {
    throw new ApiError(400, 'value_invalid', 'El certificado debe venir en PEM (-----BEGIN CERTIFICATE-----)');
  }
}
