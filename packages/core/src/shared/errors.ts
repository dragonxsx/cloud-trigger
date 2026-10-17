import { z } from 'zod';

export interface DomainError<C extends string = string> {
  readonly code: C;
  readonly message: string;
}

export const ConfigIssue = z.object({ path: z.string(), message: z.string() });
export type ConfigIssue = z.output<typeof ConfigIssue>;

export interface ConfigError extends DomainError<'invalid_config'> {
  readonly issues: readonly ConfigIssue[];
}

export const configErrorFromZod = (error: z.ZodError, prefix = ''): ConfigError => ({
  code: 'invalid_config',
  message: `Invalid configuration${prefix ? ` for ${prefix}` : ''}`,
  issues: error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  })),
});

export type UnknownProviderError = DomainError<'unknown_provider'>;
export type InvalidTransitionError = DomainError<'invalid_transition'>;
export type VersionConflictError = DomainError<'version_conflict'>;
export type NotFoundError = DomainError<'not_found'>;
