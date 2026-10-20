import { type Persistence, ProviderRegistry } from '@cloud-trigger/core';
import { Global, Module } from '@nestjs/common';

import { ShutdownHook } from '../../common/shutdown-hook.js';
import { factoryProvider, injectionToken, token } from '../../common/tokens.js';
import { databaseConfig } from '../../config/config.js';
import { ConfigService } from '../../config/config.module.js';
import { cipherFromConfig, sealPersistence } from '../crypto/sealing.js';
import { LOGGER } from '../logging/logging.module.js';
import { createPersistence } from './persistence.js';

export const PERSISTENCE = token<Persistence>('PERSISTENCE');

@Global()
@Module({
  providers: [
    factoryProvider(
      PERSISTENCE,
      [ConfigService, LOGGER, ProviderRegistry],
      async ({ values }, logger, registry) => {
        const database = databaseConfig(values);
        if (database.isErr()) {
          throw new Error(
            `No usable database: ${database.error.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
          );
        }
        const persistence = await createPersistence(database.value, values, logger);
        await persistence.migrate();

        return sealPersistence(persistence, { registry, cipher: cipherFromConfig(values) });
      },
    ),
    factoryProvider(
      token<ShutdownHook>('PERSISTENCE_SHUTDOWN'),
      [PERSISTENCE],
      (persistence) => new ShutdownHook(() => persistence.close()),
    ),
  ],
  exports: [injectionToken(PERSISTENCE)],
})
export class PersistenceModule {}
