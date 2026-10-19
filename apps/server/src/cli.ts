import { Username } from '@cloud-trigger/core';

import { resetAdmin } from './auth/reset-admin.js';
import { databaseConfig, loadConfig } from './config/config.js';
import { openPersistence } from './infra/persistence/persistence.js';

const USAGE = 'Usage: node dist/cli.js reset-admin <username>';

async function main(args: readonly string[]): Promise<void> {
  const [command, rawUsername] = args;
  const username = Username.safeParse(rawUsername);
  if (command !== 'reset-admin' || !username.success) {
    throw new Error(USAGE);
  }
  const database = databaseConfig(loadConfig());
  if (database.isErr()) {
    throw new Error(database.error.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  }
  const persistence = await openPersistence(database.value, { onEventBusError: () => undefined });
  try {
    const { password, enabledLocal } = await resetAdmin(persistence, username.data);
    if (enabledLocal) {
      process.stdout.write('Password sign-in was turned off; it is on again.\n');
    }
    process.stdout.write(`Admin "${username.data}" can now sign in with: ${password}\n`);
  } finally {
    await persistence.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
