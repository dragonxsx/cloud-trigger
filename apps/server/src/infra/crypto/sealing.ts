import type { Persistence, ProviderRegistry, SecretCipher } from '@cloud-trigger/core';
import { sealedPersistence } from '@cloud-trigger/engine';

import type { AppConfig } from '../../config/config.js';
import { createAesGcmCipher } from './aes-gcm-cipher.js';

export const cipherFromConfig = (config: AppConfig): SecretCipher =>
  createAesGcmCipher({
    current: config.DATA_ENCRYPTION_KEY,
    previous: config.DATA_ENCRYPTION_PREVIOUS_KEYS,
  });

export async function sealPersistence(
  raw: Persistence,
  deps: { readonly registry: ProviderRegistry; readonly cipher: SecretCipher },
): Promise<Persistence> {
  const persistence = sealedPersistence(raw, deps);
  await persistence.authSettings.get();

  return persistence;
}
