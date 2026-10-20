import { type Persistence, Username, silentLogger } from '@cloud-trigger/core';
import { type ResealCount, type SealingDeps, resealSecrets } from '@cloud-trigger/engine';
import { Command, InvalidArgumentError } from 'commander';

import { resetAdmin } from './auth/reset-admin.js';
import { type AppConfig, databaseConfig, loadConfig } from './config/config.js';
import { cipherFromConfig, sealPersistence } from './infra/crypto/sealing.js';
import { openPersistence } from './infra/persistence/persistence.js';
import { createProviderRegistry } from './infra/providers/registry.js';

async function withPersistence(
  config: AppConfig,
  work: (raw: Persistence, sealed: Persistence, deps: SealingDeps) => Promise<void>,
): Promise<void> {
  const database = databaseConfig(config);
  if (database.isErr()) {
    throw new Error(database.error.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  }
  const registry = await createProviderRegistry(config.PLUGINS, silentLogger);
  const persistence = await openPersistence(database.value, { onEventBusError: () => undefined });
  try {
    const deps = { registry, cipher: cipherFromConfig(config) };
    await work(persistence, await sealPersistence(persistence, deps), deps);
  } finally {
    await persistence.close();
    await registry.dispose();
  }
}

const parseUsername = (value: string): string => {
  const username = Username.safeParse(value);
  if (!username.success) {
    throw new InvalidArgumentError(username.error.issues.map((issue) => issue.message).join('; '));
  }

  return username.data;
};

const program = new Command('cli').showHelpAfterError();

program
  .command('reset-admin')
  .description('Reset the password of an admin and turn password sign-in back on.')
  .argument('<username>', 'Admin username', parseUsername)
  .action(async (username: string) => {
    await withPersistence(loadConfig(), async (_raw, sealed) => {
      const { password, enabledLocal } = await resetAdmin(sealed, username);
      if (enabledLocal) {
        process.stdout.write('Password sign-in was turned off; it is on again.\n');
      }
      process.stdout.write(`Admin "${username}" can now sign in with: ${password}\n`);
    });
  });

program
  .command('reseal-secrets')
  .description('Re-encrypt stored secrets with the current DATA_ENCRYPTION_KEY.')
  .action(async () => {
    await withPersistence(loadConfig(), async (raw, _sealed, deps) => {
      const report = await resealSecrets(raw, deps);
      for (const [entity, count] of Object.entries<ResealCount>(report)) {
        process.stdout.write(
          `${entity}: ${count.resealed} resealed, ${count.skipped} skipped (changed meanwhile; run again), ${count.scanned} scanned\n`,
        );
      }
    });
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
