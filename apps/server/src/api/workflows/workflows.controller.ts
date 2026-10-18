import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { WorkflowsRouter } from './workflows.router.js';

@Controller()
export class WorkflowsController {
  constructor(@Inject(WorkflowsRouter) private readonly router: WorkflowsRouter) {}

  @Implement(contract.workflows)
  workflows() {
    return this.router.workflows;
  }

  @Implement(contract.workflowRuns)
  workflowRuns() {
    return this.router.workflowRuns;
  }
}
