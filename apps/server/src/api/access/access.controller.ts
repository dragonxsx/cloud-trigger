import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { AccessRouter } from './access.router.js';

@Controller()
export class AccessController {
  constructor(@Inject(AccessRouter) private readonly router: AccessRouter) {}

  @Implement(contract.authSettings)
  authSettings() {
    return this.router.handlers.authSettings;
  }

  @Implement(contract.users)
  users() {
    return this.router.handlers.users;
  }

  @Implement(contract.apiKeys)
  apiKeys() {
    return this.router.handlers.apiKeys;
  }
}
