import { JobService } from '@cloud-trigger/engine';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { factoryProvider } from '../common/tokens.js';
import { ConfigService } from '../config/config.module.js';
import { EngineModule } from '../engine/engine.module.js';
import { PERSISTENCE } from '../infra/persistence/persistence.module.js';
import { FeedsController } from './feeds.controller.js';
import { FeedsService } from './feeds.service.js';

@Module({
  imports: [AuthModule, EngineModule],
  controllers: [FeedsController],
  providers: [
    factoryProvider(
      FeedsService,
      [PERSISTENCE, JobService, ConfigService],
      (persistence, jobService, { values }) =>
        new FeedsService(persistence, jobService, values.PUBLIC_URL),
    ),
  ],
})
export class FeedsModule {}
