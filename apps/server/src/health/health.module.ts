import { Module } from '@nestjs/common';

import { factoryProvider } from '../common/tokens.js';
import { ConfigService } from '../config/config.module.js';
import { PERSISTENCE } from '../infra/persistence/persistence.module.js';
import { HealthController } from './health.controller.js';
import { Readiness } from './readiness.js';

@Module({
  controllers: [HealthController],
  providers: [
    factoryProvider(
      Readiness,
      [PERSISTENCE, ConfigService],
      (persistence, { values }) => new Readiness(() => persistence.ping(), values.APP_ROLE),
    ),
  ],
})
export class HealthModule {}
