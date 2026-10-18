import { WorkflowService } from '@cloud-trigger/engine';
import { Module } from '@nestjs/common';

import { factoryProvider } from '../../common/tokens.js';
import { EngineModule } from '../../engine/engine.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { JobRedactor } from '../shared/redaction.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsRouter, workflowRunsHandlers, workflowsHandlers } from './workflows.router.js';

@Module({
  imports: [ApiSharedModule, EngineModule],
  controllers: [WorkflowsController],
  providers: [
    factoryProvider(
      WorkflowsRouter,
      [ORPC_API, WorkflowService, JobRedactor],
      (api, workflowService, redactor) => {
        const deps = { api, workflowService, redactor };

        return new WorkflowsRouter(workflowsHandlers(deps), workflowRunsHandlers(deps));
      },
    ),
  ],
  exports: [WorkflowsRouter],
})
export class WorkflowsModule {}
