import 'reflect-metadata';
import { createServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import type Redis from 'ioredis';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { internalOnlyOn, rateLimit, securityHeaders } from './common/hardening';
import { deployedConfigProblems } from './common/secrets-check';
import { REDIS } from './common/idempotency.interceptor';

async function bootstrap() {
  const problems = deployedConfigProblems(process.env);
  if (problems.length) {
    console.error(`Configuración insegura, no se arranca:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Detrás del balanceador: IP real del cliente para los límites de intentos
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(securityHeaders({ hsts: process.env.COOKIE_SECURE !== 'false' }));
  // /internal y /admin solo en el puerto privado (red interna del hosting o VPN)
  const internalPort = process.env.INTERNAL_PORT ? Number(process.env.INTERNAL_PORT) : null;
  if (internalPort) app.use(internalOnlyOn(internalPort));
  app.use(rateLimit(app.get<Redis>(REDIS)));
  // Estilos y scripts del sitio y del dashboard (public/assets)
  app.useStaticAssets(join(process.cwd(), 'public', 'assets'), { prefix: '/assets/', maxAge: '1h' });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
  if (internalPort) {
    const internal = createServer(app.getHttpAdapter().getInstance()).listen(internalPort);
    process.once('SIGTERM', () => internal.close());
  }
}
void bootstrap();
