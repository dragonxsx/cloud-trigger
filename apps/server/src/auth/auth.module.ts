import { Module } from '@nestjs/common';

import { factoryProvider } from '../common/tokens.js';
import { ConfigService } from '../config/config.module.js';
import { Authenticator } from './authenticator.js';
import { CalendarTokens } from './calendar-tokens.js';

@Module({
  providers: [
    factoryProvider(Authenticator, [ConfigService], ({ values }) => new Authenticator(values)),
    factoryProvider(
      CalendarTokens,
      [ConfigService],
      ({ values }) => new CalendarTokens(values.CALENDAR_TOKEN_SECRET),
    ),
  ],
  exports: [Authenticator, CalendarTokens],
})
export class AuthModule {}
