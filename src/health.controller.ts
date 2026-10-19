import { Controller, Get, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { ApiError } from './common/errors';
import { REDIS } from './common/idempotency.interceptor';
import { PG_POOL } from './database/database';

/** Para el balanceador y el orquestador: 200 solo si PostgreSQL y Redis responden. */
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(REDIS) private readonly redis: Redis) {}

  @Get()
  async check() {
    try {
      await Promise.all([this.pool.query('SELECT 1'), this.redis.ping()]);
    } catch (e) {
      throw new ApiError(503, 'unhealthy', `Dependencia caída: ${(e as Error).message}`, 'api_error');
    }
    return { ok: true };
  }
}
