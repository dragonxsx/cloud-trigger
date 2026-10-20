import { createHash } from 'node:crypto';

import { SEALED_PREFIX, type SecretCipher, err, ok } from '@cloud-trigger/core';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToUtf8, managedNonce, utf8ToBytes } from '@noble/ciphers/utils.js';

const AAD = utf8ToBytes('cloud-trigger/secret/v1');
const aesGcm = managedNonce(gcm);

export const encryptionKeyId = (key: Buffer): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 8);

const decrypt = (key: Buffer, blob: string): string | undefined => {
  try {
    return bytesToUtf8(aesGcm(key, AAD).decrypt(Buffer.from(blob, 'base64url')));
  } catch {
    return undefined;
  }
};

export function createAesGcmCipher(keys: {
  readonly current: Buffer;
  readonly previous: readonly Buffer[];
}): SecretCipher {
  const currentKeyId = encryptionKeyId(keys.current);
  const keyring = new Map(
    [keys.current, ...keys.previous].map((key) => [encryptionKeyId(key), key] as const),
  );

  return {
    currentKeyId,
    seal: (plaintext) => {
      const blob = Buffer.from(aesGcm(keys.current, AAD).encrypt(utf8ToBytes(plaintext)));

      return `${SEALED_PREFIX}${currentKeyId}:${blob.toString('base64url')}`;
    },
    open: (sealed) => {
      const [keyId = '', blob = ''] = sealed.slice(SEALED_PREFIX.length).split(':');
      const key = keyring.get(keyId);
      if (!key) {
        return err({
          code: 'secret_key_unknown',
          message: `No configured key has id ${keyId}`,
          keyId,
        });
      }
      const plaintext = decrypt(key, blob);

      return plaintext === undefined
        ? err({ code: 'secret_tampered', message: 'The secret failed authentication', keyId })
        : ok(plaintext);
    },
  };
}
