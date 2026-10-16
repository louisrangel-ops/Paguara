import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { MerchantsService } from '../merchants/merchants.service';
import { ApiError } from './errors';

export interface MerchantRequest extends Request {
  merchantId: string;
  livemode: boolean;
}

/**
 * API del servidor del comercio: `Authorization: Bearer sk_live_...` o `sk_test_...`.
 * Solo se compara el hash SHA-256. Las llaves de prueba funcionan mientras el
 * KYC está pendiente; las live exigen comercio activo.
 *
 * Sandbox y producción son despliegues separados (LIVEMODE=false|true), cada uno
 * con su propia base: un pago de prueba jamás toca el ledger real.
 */
export const INSTANCE_LIVEMODE = process.env.LIVEMODE === 'true';

@Injectable()
export class SecretKeyGuard implements CanActivate {
  constructor(private readonly merchants: MerchantsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<MerchantRequest>();
    const raw = /^Bearer (\S+)$/.exec(req.header('authorization') ?? '')?.[1];
    if (!raw?.startsWith('sk_')) throw new ApiError(401, 'unauthenticated', 'Se requiere una llave secreta (Authorization: Bearer sk_...)');
    const key = await this.merchants.authenticate(raw);
    if (!key || key.kind !== 'secret') throw new ApiError(401, 'unauthenticated', 'Llave inválida o revocada');
    assertKeyMatchesInstance(key.livemode);
    assertMerchantCanOperate(key.merchantStatus, key.livemode);
    req.merchantId = key.merchantId;
    req.livemode = key.livemode;
    return true;
  }
}

export function assertKeyMatchesInstance(livemode: boolean) {
  if (livemode !== INSTANCE_LIVEMODE) {
    throw new ApiError(401, 'wrong_environment', livemode
      ? 'Llave live usada contra el sandbox'
      : 'Llave de prueba usada contra producción; usa el sandbox');
  }
}

export function assertMerchantCanOperate(status: string, livemode: boolean) {
  if (status === 'closed' || status === 'restricted') throw new ApiError(403, 'account_restricted', 'El comercio no puede operar');
  if (livemode && status !== 'active') throw new ApiError(403, 'account_not_activated', 'Completa el KYC para usar llaves live');
}

/**
 * Checkout en el navegador: `Authorization: Bearer pk_...`. La llave publicable
 * solo identifica al comercio; cada operación además exige el client_secret
 * del intent (ver PaymentIntentsService.authorizeCheckout).
 */
@Injectable()
export class PublishableKeyGuard implements CanActivate {
  constructor(private readonly merchants: MerchantsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<MerchantRequest>();
    const raw = /^Bearer (\S+)$/.exec(req.header('authorization') ?? '')?.[1];
    if (!raw?.startsWith('pk_')) throw new ApiError(401, 'unauthenticated', 'Se requiere una llave publicable (Authorization: Bearer pk_...)');
    const key = await this.merchants.authenticate(raw);
    if (!key || key.kind !== 'publishable') throw new ApiError(401, 'unauthenticated', 'Llave inválida o revocada');
    assertKeyMatchesInstance(key.livemode);
    assertMerchantCanOperate(key.merchantStatus, key.livemode);
    req.merchantId = key.merchantId;
    req.livemode = key.livemode;
    return true;
  }
}
