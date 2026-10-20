import type { Result } from 'neverthrow';

import type { DomainError } from '../shared/errors.js';

export const SEALED_PREFIX = 'ctenc:v1:';

export type SecretKeyUnknownError = DomainError<'secret_key_unknown'> & { readonly keyId: string };
export type SecretTamperedError = DomainError<'secret_tampered'> & { readonly keyId: string };
export type SecretOpenError = SecretKeyUnknownError | SecretTamperedError;

export interface SecretCipher {
  readonly currentKeyId: string;
  readonly seal: (plaintext: string) => string;
  readonly open: (sealed: string) => Result<string, SecretOpenError>;
}

export const isSealed = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(SEALED_PREFIX);

export const sealedKeyId = (sealed: string): string | undefined =>
  isSealed(sealed) ? sealed.slice(SEALED_PREFIX.length).split(':', 1)[0] : undefined;
