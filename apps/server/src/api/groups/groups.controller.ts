import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { GroupsRouter } from './groups.router.js';

@Controller()
export class GroupsController {
  constructor(@Inject(GroupsRouter) private readonly router: GroupsRouter) {}

  @Implement(contract.groups)
  groups() {
    return this.router.handlers;
  }
}
