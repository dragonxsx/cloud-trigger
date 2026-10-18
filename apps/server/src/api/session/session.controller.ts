import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { SessionRouter } from './session.router.js';

@Controller()
export class SessionController {
  constructor(@Inject(SessionRouter) private readonly router: SessionRouter) {}

  @Implement(contract.auth)
  auth() {
    return this.router.handlers;
  }
}
