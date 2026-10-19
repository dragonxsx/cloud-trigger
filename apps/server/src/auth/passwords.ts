import type { PasswordHasher } from '@cloud-trigger/core';
import { hash, verify } from '@node-rs/argon2';

export const argon2PasswordHasher: PasswordHasher = {
  hash: (password) => hash(password),
  verify: async (digest, password) => {
    try {
      return await verify(digest, password);
    } catch {
      return false;
    }
  },
};
