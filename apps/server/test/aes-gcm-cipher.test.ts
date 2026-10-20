import { SEALED_PREFIX, sealedKeyId } from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';

import { createAesGcmCipher, encryptionKeyId } from '../src/infra/crypto/aes-gcm-cipher.js';

const keyA = Buffer.alloc(32, 1);
const keyB = Buffer.alloc(32, 2);

describe('aes-gcm cipher', () => {
  it('round-trips with a fresh IV each time', () => {
    const cipher = createAesGcmCipher({ current: keyA, previous: [] });
    const first = cipher.seal('s3cret');
    const second = cipher.seal('s3cret');

    expect(first.startsWith(`${SEALED_PREFIX}${encryptionKeyId(keyA)}:`)).toBe(true);
    expect(first).not.toBe(second);
    expect(first).not.toContain('s3cret');
    expect(cipher.open(first)._unsafeUnwrap()).toBe('s3cret');
    expect(cipher.open(cipher.seal(''))._unsafeUnwrap()).toBe('');
  });

  it('opens values sealed under a previous key and seals with the current one', () => {
    const old = createAesGcmCipher({ current: keyA, previous: [] }).seal('s3cret');
    const rotated = createAesGcmCipher({ current: keyB, previous: [keyA] });

    expect(rotated.open(old)._unsafeUnwrap()).toBe('s3cret');
    expect(sealedKeyId(rotated.seal('s3cret'))).toBe(encryptionKeyId(keyB));
  });

  it('rejects unknown keys and tampered values', () => {
    const sealed = createAesGcmCipher({ current: keyA, previous: [] }).seal('s3cret');
    const other = createAesGcmCipher({ current: keyB, previous: [] });
    expect(other.open(sealed)._unsafeUnwrapErr()).toMatchObject({
      code: 'secret_key_unknown',
      keyId: encryptionKeyId(keyA),
    });

    const cipher = createAesGcmCipher({ current: keyA, previous: [] });
    const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === 'A' ? 'B' : 'A'}${sealed.slice(-1)}`;
    expect(cipher.open(flipped)._unsafeUnwrapErr().code).toBe('secret_tampered');
    expect(cipher.open(`${SEALED_PREFIX}${encryptionKeyId(keyA)}:x`)._unsafeUnwrapErr().code).toBe(
      'secret_tampered',
    );
  });
});
