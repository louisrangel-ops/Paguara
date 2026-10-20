import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { grantSandboxMethods } from '../capabilities/capability-state';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { ApiError } from '../common/errors';
import { REDIS } from '../common/idempotency.interceptor';
import { PG_POOL, withTransaction } from '../database/database';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SESSION_DAYS = 14;
export const COOKIE = 'sid';
const RIF = /^[JGVEP]-?\d{8}-?\d$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type DashboardRole = 'owner' | 'admin' | 'developer' | 'viewer';
export interface SessionUser { userId: string; merchantId: string; email: string; name: string; role: DashboardRole }
export interface DashboardRequest extends Request { session: SessionUser }

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(got, expected);
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.header('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Secure salvo que se indique lo contrario (desarrollo local en http). */
function cookieAttrs(maxAgeSeconds: number) {
  const secure = process.env.COOKIE_SECURE !== 'false';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

// Un hash fijo para comparar cuando el correo no existe: la respuesta tarda lo mismo
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

@Injectable()
export class AuthService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(REDIS) private readonly redis: Redis) {}

  /** Crea comercio (KYC pendiente) + usuario dueño en una sola transacción. */
  async signup(input: { name?: string; email?: string; password?: string; business_name?: string; rif?: string }) {
    const name = (input.name ?? '').trim();
    const email = (input.email ?? '').trim().toLowerCase();
    const password = input.password ?? '';
    const business = (input.business_name ?? '').trim();
    const rif = (input.rif ?? '').trim().toUpperCase();
    const bad = (param: string, msg: string) => new ApiError(400, 'signup_invalid', msg, 'invalid_request_error', { param });
    if (name.length < 2) throw bad('name', 'Escribe tu nombre');
    if (!EMAIL.test(email)) throw bad('email', 'Escribe un correo válido');
    if (password.length < 10 || password.length > 200) throw bad('password', 'La contraseña debe tener al menos 10 caracteres');
    if (business.length < 2 || business.length > 120) throw bad('business_name', 'Escribe el nombre de tu negocio');
    if (!RIF.test(rif)) throw bad('rif', 'El RIF debe tener el formato J-12345678-9');
    const normalizedRif = rif.replace(/^([JGVEP])-?(\d{8})-?(\d)$/, '$1-$2-$3');

    const passwordHash = await hashPassword(password);
    const merchantId = `acct_${randomBytes(8).toString('hex')}`;
    const userId = `usr_${randomBytes(8).toString('hex')}`;
    try {
      await withTransaction(this.pool, async (c) => {
        await c.query('INSERT INTO merchants.merchants (id, business_name, rif) VALUES ($1, $2, $3)', [merchantId, business, normalizedRif]);
        await c.query('INSERT INTO dashboard.users (id, merchant_id, email, name, password_hash) VALUES ($1, $2, $3, $4, $5)',
          [userId, merchantId, email, name, passwordHash]);
        await grantSandboxMethods(c, merchantId);
      });
    } catch (e) {
      const err = e as { code?: string; constraint?: string };
      if (err.code === '23505' && err.constraint === 'users_email_idx') throw bad('email', 'Ya existe una cuenta con ese correo. Entra con tu contraseña.');
      if (err.code === '23505') throw bad('rif', 'Ese RIF ya está registrado. Si es tu empresa, escríbenos para recuperar el acceso.');
      throw e;
    }
    return { userId, merchantId };
  }

  /** 10 intentos fallidos por correo cada 15 min y 50 por IP: frena adivinar contraseñas. */
  async login(emailRaw: string, password: string, ip: string) {
    const email = (emailRaw ?? '').trim().toLowerCase();
    const keys = [`login:fail:email:${sha256(email)}`, `login:fail:ip:${ip}`];
    const [byEmail, byIp] = await this.redis.mget(...keys);
    if (Number(byEmail) >= 10 || Number(byIp) >= 50) {
      throw new ApiError(429, 'too_many_attempts', 'Demasiados intentos. Espera 15 minutos o recupera tu contraseña.');
    }
    const { rows } = await this.pool.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM dashboard.users WHERE email = $1', [email]);
    const ok = await verifyPassword(password ?? '', rows[0]?.password_hash ?? DUMMY_HASH);
    if (!rows[0] || !ok) {
      const m = this.redis.multi();
      for (const k of keys) m.incr(k).expire(k, 15 * 60);
      await m.exec();
      throw new ApiError(401, 'invalid_credentials', 'Correo o contraseña incorrectos');
    }
    await this.redis.del(keys[0]);
    await this.pool.query('UPDATE dashboard.users SET last_login_at = now() WHERE id = $1', [rows[0].id]);
    return rows[0].id;
  }

  async startSession(userId: string, res: Response): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.pool.query(
      `INSERT INTO dashboard.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
      [sha256(token), userId, SESSION_DAYS]);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(SESSION_DAYS * 86400)}`);
    return token;
  }

  async endSession(req: Request, res: Response) {
    const token = readCookie(req, COOKIE);
    if (token) await this.pool.query('UPDATE dashboard.sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(token)]);
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`);
  }

  async resolve(token: string): Promise<SessionUser | null> {
    const { rows } = await this.pool.query<{ id: string; merchant_id: string; email: string; name: string; role: DashboardRole }>(
      `SELECT u.id, u.merchant_id, u.email, u.name, u.role FROM dashboard.sessions s JOIN dashboard.users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(token)]);
    const u = rows[0];
    return u ? { userId: u.id, merchantId: u.merchant_id, email: u.email, name: u.name, role: u.role } : null;
  }
}

/** Exige la cabecera X-Requested-With en todo lo que no sea GET: otro sitio no puede enviarla sin CORS. */
export function assertSameOriginWrite(req: Request) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.header('x-requested-with') !== 'fetch') {
    throw new ApiError(403, 'csrf_rejected', 'Pedido rechazado: falta la cabecera X-Requested-With');
  }
}

/** Lo que cambia cómo cobra la cuenta (métodos, módulos) solo lo hacen el dueño y los administradores. */
export function assertCanManageAccount(s: SessionUser) {
  if (s.role !== 'owner' && s.role !== 'admin') {
    throw new ApiError(403, 'insufficient_role', 'Solo el dueño o un administrador de la cuenta puede cambiar esto');
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<DashboardRequest>();
    assertSameOriginWrite(req);
    const token = readCookie(req, COOKIE);
    const session = token ? await this.auth.resolve(token) : null;
    if (!session) throw new ApiError(401, 'unauthenticated', 'Tu sesión venció. Vuelve a entrar.');
    req.session = session;
    return true;
  }
}
