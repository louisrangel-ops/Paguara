import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from './errors';
import { InvalidTransitionError } from '../payment-intents/payment-intent.state-machine';
import { AmountTooSmallError } from '../payment-intents/pricing';
import { RateUnavailableError } from '../fx/fx.service';

/** Todo error sale como { error: { type, code, message } }. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('ApiError');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const e = toApiError(err);
    if (e.httpStatus >= 500) this.log.error(err instanceof Error ? err.stack : String(err));
    res.status(e.httpStatus).json({ error: { type: e.type, code: e.code, message: e.message, ...e.extra } });
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof InvalidTransitionError) return new ApiError(409, err.code, err.message, 'invalid_request_error', { status: err.from });
  if (err instanceof AmountTooSmallError) return new ApiError(400, err.code, err.message);
  if (err instanceof RateUnavailableError) return new ApiError(503, err.code, err.message, 'api_error');
  if (err instanceof HttpException) return new ApiError(err.getStatus(), 'invalid_request', err.message);
  const pgCode = (err as { code?: string }).code;
  if (pgCode === '23505' && (err as { constraint?: string }).constraint === 'payment_intents_rail_ref_idx') {
    // La misma referencia bancaria no puede confirmar dos pagos (transferencia P2P o Zelle reutilizada)
    return new ApiError(409, 'rail_reference_already_used', 'Esa referencia del banco ya confirmó otro pago', 'payment_error');
  }
  if (pgCode === 'P0003') return new ApiError(409, 'insufficient_balance', (err as Error).message, 'api_error');
  if (pgCode === 'P0011' || pgCode === 'P0012') return new ApiError(409, 'payment_intent_unexpected_state', (err as Error).message);
  return new ApiError(500, 'internal_error', 'Error interno', 'api_error');
}
