import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';
import { Logger } from '@nestjs/common';

/**
 * Defensas de borde que aplica main.ts a todas las respuestas:
 * cabeceras de seguridad, rutas internas solo en su puerto privado y límite de
 * peticiones por llave o por IP.
 */

// ---- Cabeceras -------------------------------------------------------------

/** La única librería externa es qrcodejs (checkout); las fuentes vienen de Google Fonts. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(opts: { hsts: boolean }) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (opts.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.removeHeader('X-Powered-By');
    next();
  };
}

// ---- Rutas internas ----------------------------------------------------------

/** El panel interno y su API: KYC, métodos por contrato, tasas, resultados de rieles y liquidaciones. */
export function isInternalPath(path: string): boolean {
  return path === '/admin' || path === '/admin/' || path === '/internal' || path.startsWith('/internal/');
}

/**
 * Con INTERNAL_PORT, /internal y /admin solo responden en ese puerto (red
 * privada del hosting o VPN); en el puerto público dan 404 como si no existieran.
 */
export function internalOnlyOn(internalPort: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isInternalPath(req.path) && req.socket.localPort !== internalPort) {
      res.status(404).json({ error: { type: 'invalid_request_error', code: 'not_found', message: 'No existe' } });
      return;
    }
    next();
  };
}

// ---- Límite de peticiones ----------------------------------------------------

export interface RateRule { bucket: string; limit: number }

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

/**
 * Cuántas peticiones por minuto se permiten y a quién se cuentan. La API del
 * comercio cuenta por llave (así un comercio no frena a otro detrás del mismo
 * NAT); el checkout, el panel y los links, por IP. Las rutas internas no tienen
 * límite: están fuera de internet.
 */
export function rateRule(req: Pick<Request, 'path' | 'ip' | 'header'>, env: NodeJS.ProcessEnv = process.env): RateRule | null {
  const n = (k: string, d: number) => { const v = Number(env[k]); return Number.isInteger(v) && v > 0 ? v : d; };
  const ip = req.ip ?? 'unknown';
  const p = req.path;
  if (isInternalPath(p) || p === '/health') return null;
  if (p.startsWith('/v1/checkout/')) return { bucket: `ip:${ip}:checkout`, limit: n('RATE_LIMIT_CHECKOUT_PER_MIN', 120) };
  if (p.startsWith('/v1/')) {
    const auth = req.header('authorization') ?? '';
    return { bucket: auth ? `key:${sha(auth)}` : `ip:${ip}:api`, limit: n('RATE_LIMIT_API_PER_MIN', 600) };
  }
  if (p.startsWith('/api/')) return { bucket: `ip:${ip}:dashboard`, limit: n('RATE_LIMIT_DASHBOARD_PER_MIN', 300) };
  return null;
}

/** Ventana fija de un minuto en Redis. Si Redis falla se deja pasar (y se registra): mejor lento que caído. */
export function rateLimit(redis: Redis, env: NodeJS.ProcessEnv = process.env) {
  const log = new Logger('RateLimit');
  return async (req: Request, res: Response, next: NextFunction) => {
    const rule = rateRule(req, env);
    if (!rule) return next();
    const window = Math.floor(Date.now() / 60_000);
    const key = `rl:${rule.bucket}:${window}`;
    try {
      const [[, count]] = (await redis.multi().incr(key).pexpire(key, 61_000).exec()) as [[Error | null, number]];
      res.setHeader('RateLimit-Limit', String(rule.limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, rule.limit - count)));
      if (count > rule.limit) {
        res.setHeader('Retry-After', String(60 - Math.floor((Date.now() / 1000) % 60)));
        res.status(429).json({ error: { type: 'rate_limit_error', code: 'rate_limited', message: 'Demasiadas peticiones; espera un momento y reintenta' } });
        return;
      }
    } catch (e) {
      log.warn(`Sin límite de peticiones (Redis): ${(e as Error).message}`);
    }
    next();
  };
}
