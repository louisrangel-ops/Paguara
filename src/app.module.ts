import { Module } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS, IdempotencyInterceptor } from './common/idempotency.interceptor';
import { CheckoutPageController } from './checkout-page.controller';
import { createPool, PG_POOL } from './database/database';
import { MerchantsService } from './merchants/merchants.service';
import { PublishableKeyGuard, SecretKeyGuard } from './common/api-key.guard';
import { FxService } from './fx/fx.service';
import { LedgerService } from './ledger/ledger.service';
import { PaymentIntentRepository } from './payment-intents/payment-intent.repository';
import { CheckoutController, PaymentIntentsController } from './payment-intents/payment-intents.controller';
import { PaymentIntentsService } from './payment-intents/payment-intents.service';
import { PAYMENT_METHODS } from './payment-intents/payment-methods';
import { RAIL_ADAPTERS, RailAdapter } from './payment-intents/rails/rail-adapter';
import { SandboxRail } from './payment-intents/rails/sandbox.rail';
import { InternalController, InternalTokenGuard } from './settlements/internal.controller';
import { SettlementsService } from './settlements/settlements.service';
import { AuthService, SessionGuard } from './dashboard/auth.service';
import { DashboardAuthController, DashboardController, PublicController, SitePageController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { WebhooksService } from './webhooks/webhooks.service';

/** Mientras no haya conectores reales, todos los rieles usan el sandbox (también en LIVEMODE=true: no hay rieles live aún). */
function sandboxRails(): Map<string, RailAdapter> {
  const rails = new Map<string, RailAdapter>();
  for (const { rail } of Object.values(PAYMENT_METHODS)) rails.set(rail, new SandboxRail(rail));
  return rails;
}

@Module({
  controllers: [PaymentIntentsController, CheckoutController, CheckoutPageController, InternalController,
    DashboardAuthController, DashboardController, PublicController, SitePageController],
  providers: [
    { provide: PG_POOL, useFactory: () => createPool() },
    { provide: REDIS, useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379') },
    { provide: RAIL_ADAPTERS, useFactory: sandboxRails },
    LedgerService,
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
  ],
  exports: [PG_POOL, LedgerService, FxService, PaymentIntentsService, SettlementsService],
})
export class AppModule {}
