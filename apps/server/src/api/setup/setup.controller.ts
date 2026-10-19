import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { SetupRouter } from './setup.router.js';

@Controller()
export class SetupController {
  constructor(@Inject(SetupRouter) private readonly router: SetupRouter) {}

  @Implement(contract.setup)
  setup() {
    return this.router.handlers;
  }
}
