import type { Persistence } from '@cloud-trigger/core';
import { Global, Module } from '@nestjs/common';

import { ShutdownHook } from '../../common/shutdown-hook.js';
import { factoryProvider, injectionToken, token } from '../../common/tokens.js';
import { ConfigService } from '../../config/config.module.js';
import { LOGGER } from '../logging/logging.module.js';
import { createPersistence } from './persistence.js';

export const PERSISTENCE = token<Persistence>('PERSISTENCE');

@Global()
@Module({
  providers: [
    factoryProvider(PERSISTENCE, [ConfigService, LOGGER], async ({ values }, logger) => {
      const persistence = await createPersistence(values, logger);
      await persistence.migrate();

      return persistence;
    }),
    factoryProvider(
      token<ShutdownHook>('PERSISTENCE_SHUTDOWN'),
      [PERSISTENCE],
      (persistence) => new ShutdownHook(() => persistence.close()),
    ),
  ],
  exports: [injectionToken(PERSISTENCE)],
})
export class PersistenceModule {}
