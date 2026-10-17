import type { Result } from 'neverthrow';

import type { DomainError } from '../shared/errors.js';

export type MissingSecretError = DomainError<'missing_secret'> & {
  readonly names: readonly string[];
};

export interface SecretResolver {
  get(name: string): Promise<string | undefined>;
  interpolate(text: string): Promise<Result<string, MissingSecretError>>;
}
