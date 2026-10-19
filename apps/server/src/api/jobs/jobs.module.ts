import { JobService, JobTransfer } from '@cloud-trigger/engine';
import { Module } from '@nestjs/common';

import { factoryProvider } from '../../common/tokens.js';
import { EngineModule } from '../../engine/engine.module.js';
import { PERSISTENCE } from '../../infra/persistence/persistence.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { JobRedactor } from '../shared/redaction.js';
import { JobsRouter, jobsHandlers } from './jobs.router.js';

@Module({
  imports: [ApiSharedModule, EngineModule],
  providers: [
    factoryProvider(
      JobsRouter,
      [ORPC_API, PERSISTENCE, JobService, JobTransfer, JobRedactor],
      (api, persistence, jobService, jobTransfer, redactor) =>
        new JobsRouter(jobsHandlers({ api, persistence, jobService, jobTransfer, redactor })),
    ),
  ],
  exports: [JobsRouter],
})
export class JobsModule {}
