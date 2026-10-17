import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type SecretResolver, createSecretResolver } from '@cloud-trigger/core';

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;

export function envAndFileSecretResolver(opts: {
  prefix: string;
  dir?: string | undefined;
  env?: NodeJS.ProcessEnv;
}): SecretResolver {
  const env = opts.env ?? process.env;

  return createSecretResolver(async (name) => {
    if (!SAFE_NAME.test(name)) {
      return undefined;
    }
    const fromEnv = env[`${opts.prefix}${name}`];
    if (fromEnv !== undefined) {
      return fromEnv;
    }
    if (!opts.dir) {
      return undefined;
    }
    try {
      return (await readFile(join(opts.dir, name), 'utf8')).trimEnd();
    } catch {
      return undefined;
    }
  });
}
