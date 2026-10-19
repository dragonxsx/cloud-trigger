import { randomBytes } from 'node:crypto';

import { type Persistence, newUserId, systemClock } from '@cloud-trigger/core';

import { argon2PasswordHasher } from './passwords.js';

export interface AdminReset {
  readonly password: string;
  readonly enabledLocal: boolean;
}

export async function resetAdmin(persistence: Persistence, username: string): Promise<AdminReset> {
  const settings = await persistence.authSettings.get();
  if (settings === undefined) {
    throw new Error('Setup has not been completed; use the setup wizard instead');
  }
  const password = randomBytes(15).toString('base64url');
  const passwordHash = await argon2PasswordHasher.hash(password);
  const now = systemClock.now();
  const existing = await persistence.users.findByUsername(username);
  if (!existing) {
    (
      await persistence.users.insert({
        id: newUserId(),
        username,
        passwordHash,
        scopes: ['admin'],
        disabled: false,
        tokenVersion: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
    )._unsafeUnwrap();
  } else {
    const updated = await persistence.users.update(
      {
        ...existing,
        passwordHash,
        scopes: existing.scopes.includes('admin') ? existing.scopes : [...existing.scopes, 'admin'],
        disabled: false,
        tokenVersion: existing.tokenVersion + 1,
        version: existing.version + 1,
        updatedAt: now,
      },
      existing.version,
    );
    if (updated.isErr()) {
      throw new Error(updated.error.message);
    }
  }
  if (settings.local.enabled) {
    return { password, enabledLocal: false };
  }
  const enabled = await persistence.authSettings.update(
    {
      ...settings,
      local: { ...settings.local, enabled: true },
      version: settings.version + 1,
      updatedAt: now,
    },
    settings.version,
  );
  if (enabled.isErr()) {
    throw new Error(enabled.error.message);
  }

  return { password, enabledLocal: true };
}
