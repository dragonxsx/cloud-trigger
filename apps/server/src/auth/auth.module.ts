import { Module } from '@nestjs/common';

import { factoryProvider } from '../common/tokens.js';
import { ConfigService } from '../config/config.module.js';
import { PERSISTENCE } from '../infra/persistence/persistence.module.js';
import { CLOCK } from '../infra/providers/providers.module.js';
import { AccessService } from './access-service.js';
import { Authenticator } from './authenticator.js';
import { CalendarTokens } from './calendar-tokens.js';
import { LoginThrottle } from './login-throttle.js';
import { argon2PasswordHasher } from './passwords.js';
import { AuthSettingsCache } from './settings-cache.js';
import { SetupToken } from './setup-token.js';

@Module({
  providers: [
    factoryProvider(
      AuthSettingsCache,
      [PERSISTENCE, CLOCK],
      (persistence, clock) => new AuthSettingsCache(persistence.authSettings, clock),
    ),
    factoryProvider(
      Authenticator,
      [AuthSettingsCache, PERSISTENCE, CLOCK],
      (settings, { users, apiKeys }, clock) =>
        new Authenticator({ settings, users, apiKeys, clock }),
    ),
    factoryProvider(
      AccessService,
      [PERSISTENCE, AuthSettingsCache, CLOCK],
      (persistence, settings, clock) =>
        new AccessService({
          persistence,
          settings,
          hasher: argon2PasswordHasher,
          throttle: new LoginThrottle(),
          clock,
        }),
    ),
    factoryProvider(
      SetupToken,
      [ConfigService],
      ({ values }) => new SetupToken(values.SETUP_TOKEN),
    ),
    factoryProvider(
      CalendarTokens,
      [ConfigService],
      ({ values }) => new CalendarTokens(values.CALENDAR_TOKEN_SECRET),
    ),
  ],
  exports: [Authenticator, AccessService, AuthSettingsCache, SetupToken, CalendarTokens],
})
export class AuthModule {}
