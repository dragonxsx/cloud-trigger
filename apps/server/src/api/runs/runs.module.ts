import { JobService } from '@cloud-trigger/engine';
import { Module } from '@nestjs/common';

import { factoryProvider } from '../../common/tokens.js';
import { EngineModule } from '../../engine/engine.module.js';
import { PERSISTENCE } from '../../infra/persistence/persistence.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { JobRedactor } from '../shared/redaction.js';
import { RUN_EVENTS, publishRunChanges } from './run-events.js';
import { RunsRouter, runsHandlers } from './runs.router.js';

@Module({
  imports: [ApiSharedModule, EngineModule],
  providers: [
    factoryProvider(RUN_EVENTS, [PERSISTENCE], publishRunChanges),
    factoryProvider(
      RunsRouter,
      [ORPC_API, PERSISTENCE, JobService, RUN_EVENTS, JobRedactor],
      (api, persistence, jobService, runEvents, redactor) =>
        new RunsRouter(runsHandlers({ api, persistence, jobService, runEvents, redactor })),
    ),
  ],
  exports: [RunsRouter],
})
export class RunsModule {}
