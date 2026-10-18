import { Module } from '@nestjs/common';

import { CalendarTokens } from '../../auth/calendar-tokens.js';
import { factoryProvider } from '../../common/tokens.js';
import { ConfigService } from '../../config/config.module.js';
import { ApiSharedModule, ORPC_API } from '../shared/api-shared.module.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarRouter, calendarHandlers } from './calendar.router.js';

@Module({
  imports: [ApiSharedModule],
  controllers: [CalendarController],
  providers: [
    factoryProvider(
      CalendarRouter,
      [ORPC_API, CalendarTokens, ConfigService],
      (api, tokens, { values }) =>
        new CalendarRouter(calendarHandlers({ api, tokens, config: values })),
    ),
  ],
  exports: [CalendarRouter],
})
export class CalendarModule {}
