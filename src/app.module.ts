import { Module } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS, IdempotencyInterceptor } from './common/idempotency.interceptor';
import { CheckoutPageController } from './checkout-page.controller';
import { AdminPageController } from './admin-page.controller';
import { createPool, PG_POOL } from './database/database';
import { MerchantsService } from './merchants/merchants.service';
import { INSTANCE_LIVEMODE, PublishableKeyGuard, SecretKeyGuard } from './common/api-key.guard';
import { FxService } from './fx/fx.service';
import { LedgerService } from './ledger/ledger.service';
import { PaymentIntentRepository } from './payment-intents/payment-intent.repository';
import { AccountCapabilitiesController, CheckoutController, PaymentIntentsController } from './payment-intents/payment-intents.controller';
import { CapabilitiesService } from './capabilities/capabilities.service';
import { PaymentIntentsService } from './payment-intents/payment-intents.service';
import { PAYMENT_METHODS } from './payment-intents/payment-methods';
import { RAIL_ADAPTERS, RailAdapter } from './payment-intents/rails/rail-adapter';
import { SandboxRail } from './payment-intents/rails/sandbox.rail';
import { InternalController, InternalTokenGuard } from './settlements/internal.controller';
import { SettlementsService } from './settlements/settlements.service';
import { AuthService, SessionGuard } from './dashboard/auth.service';
import { DashboardAuthController, DashboardController, PublicController, SitePageController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { HealthController } from './health.controller';
import { OperatorsService } from './settlements/operators.service';
import { SecurityTxtController } from './legal/security-txt.controller';
import { WebhooksService } from './webhooks/webhooks.service';

/**
 * Rieles por método. Aún no hay conectores con bancos reales: todos son el
 * sandbox, que aprueba cobros sin mover dinero. Por eso en LIVEMODE=true la API
 * no arranca mientras quede un riel de prueba (cobrar "en vivo" contra el
 * sandbox sumaría saldo sin dinero detrás y la liquidación pagaría dinero real).
 */
export function buildRails(livemode: boolean): Map<string, RailAdapter> {
  const rails = new Map<string, RailAdapter>();
  for (const { rail } of Object.values(PAYMENT_METHODS)) rails.set(rail, new SandboxRail(rail));
  const sandbox = [...rails].filter(([, a]) => a instanceof SandboxRail).map(([r]) => r);
  if (livemode && sandbox.length) {
    throw new Error(`LIVEMODE=true con rieles de prueba (${sandbox.join(', ')}): conecta los bancos reales o apaga esos métodos antes de cobrar dinero real`);
  }
  return rails;
}

@Module({
  controllers: [PaymentIntentsController, CheckoutController, AccountCapabilitiesController, CheckoutPageController, AdminPageController, InternalController,
    DashboardAuthController, DashboardController, PublicController, SitePageController, HealthController, SecurityTxtController],
  providers: [
    { provide: PG_POOL, useFactory: () => createPool() },
    { provide: REDIS, useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379') },
    { provide: RAIL_ADAPTERS, useFactory: () => buildRails(INSTANCE_LIVEMODE) },
    LedgerService,
    OperatorsService,
    MerchantsService,
    SecretKeyGuard,
    PublishableKeyGuard,
    FxService,
    PaymentIntentRepository,
    PaymentIntentsService,
    SettlementsService,
    IdempotencyInterceptor,
    InternalTokenGuard,
    AuthService,
    SessionGuard,
    DashboardService,
    WebhooksService,
    CapabilitiesService,
  ],
  exports: [PG_POOL, LedgerService, FxService, PaymentIntentsService, SettlementsService],
})
export class AppModule {}
