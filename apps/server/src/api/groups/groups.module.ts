import { GroupService } from '@cloud-trigger/engine';
import { Module } from '@nestjs/common';

import { factoryProvider } from '../../common/tokens.js';
import { EngineModule } from '../../engine/engine.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { JobRedactor } from '../shared/redaction.js';
import { GroupsRouter, groupsHandlers } from './groups.router.js';

@Module({
  imports: [ApiSharedModule, EngineModule],
  providers: [
    factoryProvider(
      GroupsRouter,
      [ORPC_API, GroupService, JobRedactor],
      (api, groupService, redactor) =>
        new GroupsRouter(groupsHandlers({ api, groupService, redactor })),
    ),
  ],
  exports: [GroupsRouter],
})
export class GroupsModule {}
