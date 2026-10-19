import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { ApiRouter } from './app-router.js';

@Controller()
export class ApiController {
  constructor(@Inject(ApiRouter) private readonly api: ApiRouter) {}

  @Implement(contract)
  router() {
    return this.api.router;
  }
}
