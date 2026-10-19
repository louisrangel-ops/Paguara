import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { MerchantRequest, PublishableKeyGuard, SecretKeyGuard } from '../common/api-key.guard';
import { ApiError } from '../common/errors';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { MerchantsService } from '../merchants/merchants.service';
import { isCurrency } from '../common/money';
import { toApi, toCheckoutApi } from './payment-intent.repository';
import { PaymentIntentsService } from './payment-intents.service';
import { isPaymentMethodType, PaymentMethodType } from './payment-methods';
import { methodView, parseMethodList } from '../capabilities/capability-state';
import { CapabilitiesService } from '../capabilities/capabilities.service';

function parseAmount(v: unknown): bigint {
  if ((typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^\d+$/.test(v))) return BigInt(v);
  throw new ApiError(400, 'amount_invalid', 'amount debe ser un entero en unidades mínimas (número o string)');
}

function methodType(v: unknown): PaymentMethodType {
  if (!isPaymentMethodType(v)) throw new ApiError(400, 'payment_method_invalid', `Método no soportado: ${String(v)}`);
  return v;
}

/** API del servidor del comercio (llave secreta). */
@Controller('v1/payment_intents')
@UseGuards(SecretKeyGuard)
@UseInterceptors(IdempotencyInterceptor)
export class PaymentIntentsController {
  constructor(private readonly service: PaymentIntentsService) {}

  @Post()
  async create(
    @Req() req: MerchantRequest,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: { amount: unknown; currency: string; metadata?: Record<string, unknown>; customer?: Record<string, unknown>; expires_in?: number;
                    payment_method_types?: unknown },
  ) {
    if (!isCurrency(body.currency)) throw new ApiError(400, 'currency_invalid', `Moneda no soportada: ${body.currency}`);
    return toApi(await this.service.create(req.merchantId, {
      amount: parseAmount(body.amount), currency: body.currency, metadata: body.metadata, customer: body.customer,
      expiresInSeconds: body.expires_in, idempotencyKey, livemode: req.livemode,
      paymentMethodTypes: parseMethodList(body.payment_method_types),
    }));
  }

  @Get(':id')
  async retrieve(@Req() req: MerchantRequest, @Param('id') id: string) {
    return toApi(await this.service.retrieve(req.merchantId, id));
  }

  /** Elige método de pago y devuelve el monto exacto a cobrar con la tasa congelada. */
  @Post(':id/attach')
  @HttpCode(200)
  async attach(@Req() req: MerchantRequest, @Param('id') id: string, @Body() body: { payment_method_type: string; fx_source?: string }) {
    return toApi(await this.service.attachPaymentMethod(req.merchantId, id, methodType(body.payment_method_type), body.fx_source));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(@Req() req: MerchantRequest, @Param('id') id: string, @Body() body: { payment_method_details?: Record<string, unknown> }) {
    return toApi(await this.service.confirm(req.merchantId, id, body.payment_method_details ?? {}));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Req() req: MerchantRequest, @Param('id') id: string, @Body() body: { cancellation_reason?: string }) {
    return toApi(await this.service.cancel(req.merchantId, id, body.cancellation_reason));
  }
}

/**
 * API del checkout (navegador del pagador): llave publicable + client_secret.
 * Puede ver el monto, elegir método y confirmar; no puede cancelar ni ver metadata.
 */
@Controller('v1/checkout/payment_intents')
@UseGuards(PublishableKeyGuard)
@UseInterceptors(IdempotencyInterceptor)
export class CheckoutController {
  constructor(private readonly service: PaymentIntentsService, private readonly merchants: MerchantsService) {}

  @Get(':id')
  async retrieve(@Req() req: MerchantRequest, @Param('id') id: string, @Query('client_secret') secret = '') {
    const pi = await this.service.authorizeCheckout(req.merchantId, id, secret);
    return {
      ...toCheckoutApi(pi),
      merchant: await this.merchants.publicProfile(pi.merchant_id),
      // Solo lo que este comercio tiene encendido (y, si el pago trae lista, dentro de ella), con sus precios
      payment_methods: (await this.service.availableMethods(pi)).map(methodView),
    };
  }

  @Post(':id/attach')
  @HttpCode(200)
  async attach(@Req() req: MerchantRequest, @Param('id') id: string, @Body() body: { client_secret?: string; payment_method_type: string }) {
    await this.service.authorizeCheckout(req.merchantId, id, body.client_secret ?? '');
    return toCheckoutApi(await this.service.attachPaymentMethod(req.merchantId, id, methodType(body.payment_method_type)));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(@Req() req: MerchantRequest, @Param('id') id: string,
    @Body() body: { client_secret?: string; payment_method_details?: Record<string, unknown> }) {
    await this.service.authorizeCheckout(req.merchantId, id, body.client_secret ?? '');
    return toCheckoutApi(await this.service.confirm(req.merchantId, id, body.payment_method_details ?? {}));
  }
}

/** Interruptores de la cuenta desde el servidor del comercio (llave secreta). */
@Controller('v1/account/capabilities')
@UseGuards(SecretKeyGuard)
export class AccountCapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  @Get()
  async list(@Req() req: MerchantRequest) {
    return { object: 'list', data: await this.capabilities.list(req.merchantId) };
  }

  @Post(':key')
  @HttpCode(200)
  set(@Req() req: MerchantRequest, @Param('key') key: string, @Body() body: { enabled?: unknown }) {
    return this.capabilities.setMerchantEnabled(req.merchantId, key, body.enabled, 'api_key');
  }
}
