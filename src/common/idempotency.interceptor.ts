import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import Redis from 'ioredis';
import { Observable, from, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { ApiError } from './errors';

export const REDIS = Symbol('REDIS');

const LOCK_TTL_MS = 60_000;          // dura más que la llamada más lenta a un riel
const RESULT_TTL_S = 24 * 60 * 60;   // misma ventana que Stripe

interface Stored {
  state: 'in_progress' | 'done';
  fingerprint: string;
  status?: number;
  body?: unknown;
}

/**
 * Idempotency-Key obligatorio en todo POST:
 *  · misma llave + mismo cuerpo, ya terminado  → se repite la respuesta guardada
 *  · misma llave, aún en curso                 → 409 (el cliente reintenta luego)
 *  · misma llave + cuerpo distinto             → 422
 * Redis evita trabajo duplicado; la garantía final contra doble cobro está en la
 * BD (máquina de estados con lock de fila + idempotency_key única en el ledger),
 * así que una caída de Redis no puede producir dos asientos.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & { merchantId?: string }>();
    const res = ctx.switchToHttp().getResponse<Response>();
    if (req.method !== 'POST') return next.handle();

    const key = req.header('idempotency-key');
    if (!key || key.length > 255) {
      return throwError(() => new ApiError(400, 'idempotency_key_required', 'Falta el header Idempotency-Key (máx. 255 caracteres)', 'idempotency_error'));
    }
    const redisKey = `idem:${req.merchantId ?? 'internal'}:${key}`;
    const fingerprint = createHash('sha256').update(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? {})}`).digest('hex');

    return from(this.acquire(redisKey, fingerprint)).pipe(
      mergeMap((existing) => {
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            throw new ApiError(422, 'idempotency_key_reused', 'Esta Idempotency-Key ya se usó con otros parámetros', 'idempotency_error');
          }
          if (existing.state === 'in_progress') {
            throw new ApiError(409, 'request_in_progress', 'Hay una petición en curso con esta Idempotency-Key', 'idempotency_error');
          }
          res.status(existing.status!);
          res.setHeader('Idempotent-Replayed', 'true');
          return of(existing.body);
        }
        return next.handle().pipe(
          mergeMap(async (body) => {
            const stored: Stored = { state: 'done', fingerprint, status: res.statusCode, body };
            await this.redis.set(redisKey, JSON.stringify(stored), 'EX', RESULT_TTL_S);
            return body;
          }),
          catchError(async (err) => {
            // Errores de validación/negocio (4xx) son deterministas: se guardan.
            // 5xx y conflictos transitorios liberan la llave para permitir reintento.
            if (err instanceof ApiError && err.httpStatus < 500 && err.httpStatus !== 409) {
              const body = { error: { type: err.type, code: err.code, message: err.message, ...err.extra } };
              await this.redis.set(redisKey, JSON.stringify({ state: 'done', fingerprint, status: err.httpStatus, body }), 'EX', RESULT_TTL_S);
            } else {
              await this.redis.del(redisKey);
            }
            throw err;
          }),
        );
      }),
    );
  }

  /** SET NX: devuelve null si tomamos la llave, o lo que ya estaba guardado. */
  private async acquire(redisKey: string, fingerprint: string): Promise<Stored | null> {
    const ok = await this.redis.set(redisKey, JSON.stringify({ state: 'in_progress', fingerprint }), 'PX', LOCK_TTL_MS, 'NX');
    if (ok === 'OK') return null;
    const raw = await this.redis.get(redisKey);
    return raw ? (JSON.parse(raw) as Stored) : this.acquire(redisKey, fingerprint);
  }
}
