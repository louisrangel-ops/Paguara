import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import Redis from 'ioredis';
import { ApiError } from '../common/errors';
import { REDIS } from '../common/idempotency.interceptor';
import { MfaService } from '../mfa/mfa.service';
import { Operator } from './settlements.service';
import { OperatorsService } from './operators.service';

const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';
/** Tokens de operador equivocados por IP cada 15 minutos. */
const MAX_TOKEN_FAILS = 20;

/**
 * Entrada al panel interno con doble factor obligatorio. Sin guard: aquí se
 * presenta el token `opk_…` y, con el código de la app, sale una sesión `ops_…`
 * de pocas horas, que es lo único que acepta el resto de /internal.
 *
 * La primera vez la persona no tiene doble factor: /session responde
 * `mfa_enrollment_required`, el panel pide /mfa/setup (QR) y /mfa/confirm con el
 * primer código activa el factor, entrega los códigos de respaldo y abre la sesión.
 */
@Controller('internal/auth')
export class InternalAuthController {
  constructor(private readonly operators: OperatorsService, private readonly mfa: MfaService, @Inject(REDIS) private readonly redis: Redis) {}

  @Post('session')
  @HttpCode(200)
  async session(@Req() req: Request, @Body() b: { token?: string; code?: string }) {
    const op = await this.operator(req, b.token);
    if (!(await this.mfa.isEnabled(principal(op)))) {
      return { mfa_enrollment_required: true, operator: { name: op.name, role: op.role } };
    }
    if (!b.code) throw new ApiError(400, 'mfa_code_required', 'Escribe el código de 6 dígitos de tu app autenticadora');
    const method = await this.mfa.verify(principal(op), b.code, `platform:${op.name}`);
    return { ...(await this.operators.startSession(op.id, clientIp(req))), operator: view(op), used_recovery_code: method === 'recovery_code' };
  }

  @Post('mfa/setup')
  @HttpCode(200)
  async setup(@Req() req: Request, @Body() b: { token?: string }) {
    return this.mfa.beginEnrollment(principal(await this.operator(req, b.token)));
  }

  @Post('mfa/confirm')
  @HttpCode(200)
  async confirm(@Req() req: Request, @Body() b: { token?: string; code?: string }) {
    const op = await this.operator(req, b.token);
    const { recovery_codes } = await this.mfa.confirmEnrollment(principal(op), b.code ?? '', `platform:${op.name}`);
    return { ...(await this.operators.startSession(op.id, clientIp(req))), operator: view(op), recovery_codes };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request) {
    await this.operators.endSession(req.header('x-internal-token') ?? '');
    return { ok: true };
  }

  private async operator(req: Request, token: string | undefined): Promise<Operator> {
    const key = `internal:auth:fail:${clientIp(req)}`;
    if (Number(await this.redis.get(key)) >= MAX_TOKEN_FAILS) throw new ApiError(429, 'too_many_attempts', 'Demasiados intentos. Espera 15 minutos.');
    const op = await this.operators.authenticate(token ?? '');
    if (!op) {
      await this.redis.multi().incr(key).expire(key, 15 * 60).exec();
      throw new ApiError(401, 'unauthenticated', 'Token de operador inválido o revocado');
    }
    return op;
  }
}

export const principal = (op: Operator) => ({ type: 'operator' as const, id: op.id, label: op.name });
const view = (op: Operator) => ({ id: op.id, name: op.name, role: op.role });
