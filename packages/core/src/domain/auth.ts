import { type Result, err, ok } from 'neverthrow';
import { z } from 'zod';

import type { ConfigError, ConfigIssue } from '../shared/errors.js';
import { ApiKeyId, UserId } from './ids.js';

export const Scope = z.enum(['read', 'write', 'admin']);
export type Scope = z.output<typeof Scope>;

const IMPLIED: Record<Scope, readonly Scope[]> = {
  read: ['read'],
  write: ['read', 'write'],
  admin: ['read', 'write', 'admin'],
};

export const expandScopes = (scopes: readonly Scope[]): Scope[] => [
  ...new Set(scopes.flatMap((s) => IMPLIED[s])),
];

export const LocalAuthSettings = z.object({
  enabled: z.boolean().default(true).describe('Sign in with a username and password.'),
  sessionTtlMinutes: z
    .int()
    .min(5)
    .max(43_200)
    .default(720)
    .describe('How long a password sign-in stays valid.'),
});
export type LocalAuthSettings = z.output<typeof LocalAuthSettings>;

export const OidcAuthSettings = z.object({
  enabled: z.boolean().default(false).describe('Accept tokens from an OpenID Connect provider.'),
  issuer: z.url().optional().describe('Issuer URL; discovery runs against it.'),
  audience: z.string().min(1).optional().describe('Required `aud` claim, when set.'),
  jwksUri: z.url().optional().describe('Overrides the JWKS URL from discovery.'),
  clientId: z
    .string()
    .min(1)
    .optional()
    .describe('Public client the web UI signs in with (authorization code + PKCE).'),
  uiScope: z
    .string()
    .default('openid profile cloud-trigger:read cloud-trigger:write')
    .describe('Scopes the web UI requests.'),
  scopePrefix: z
    .string()
    .default('cloud-trigger:')
    .describe('Token scopes with this prefix map to Cloud Trigger scopes.'),
  defaultScopes: z
    .array(Scope)
    .default(['read'])
    .describe('Granted when a valid token carries no Cloud Trigger scope.'),
});
export type OidcAuthSettings = z.output<typeof OidcAuthSettings>;

export const AnonymousAuthSettings = z.object({
  scopes: z
    .array(Scope)
    .default([])
    .describe('Granted to visitors without credentials. Empty turns anonymous access off.'),
});

export const AuthMethods = z.object({
  local: LocalAuthSettings.prefault({}),
  oidc: OidcAuthSettings.prefault({}),
  anonymous: AnonymousAuthSettings.prefault({}),
});
export type AuthMethods = z.output<typeof AuthMethods>;
export type AuthMethodsInput = z.input<typeof AuthMethods>;

export const AuthSettings = AuthMethods.extend({
  version: z.int().min(1),
  sessionSecret: z.string().min(32),
  completedAt: z.date(),
  updatedAt: z.date(),
});
export type AuthSettings = z.output<typeof AuthSettings>;

export const validateAuthMethods = (
  methods: AuthMethods,
  activeAdmins: number,
): Result<AuthMethods, ConfigError> => {
  const issues: ConfigIssue[] = [];
  if (methods.oidc.enabled && methods.oidc.issuer === undefined) {
    issues.push({ path: 'oidc.issuer', message: 'Required when OIDC is enabled' });
  }
  if (!methods.local.enabled && !methods.oidc.enabled) {
    issues.push({ path: 'local.enabled', message: 'Enable local accounts or OIDC' });
  }
  if (!methods.oidc.enabled && activeAdmins === 0) {
    issues.push({
      path: 'local.enabled',
      message: 'No active admin account could sign in; keep one or enable OIDC',
    });
  }

  return issues.length > 0
    ? err({ code: 'invalid_config', message: 'Invalid sign-in settings', issues })
    : ok(methods);
};

export const Username = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._@-]+$/, 'Use letters, digits, dot, underscore, @ or hyphen');

export const Password = z.string().min(12, 'Use at least 12 characters').max(256);

export const User = z.object({
  id: UserId,
  username: Username,
  passwordHash: z.string().min(1),
  scopes: z.array(Scope).min(1),
  disabled: z.boolean(),
  tokenVersion: z.int().min(0),
  version: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastLoginAt: z.date().optional(),
});
export type User = z.output<typeof User>;

export const isActiveAdmin = (user: User): boolean =>
  !user.disabled && user.scopes.includes('admin');

export const ApiKey = z.object({
  id: ApiKeyId,
  name: z.string().trim().min(1).max(100),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  prefix: z.string().min(1).max(16),
  scopes: z.array(Scope).min(1),
  createdAt: z.date(),
  lastUsedAt: z.date().optional(),
  revokedAt: z.date().optional(),
});
export type ApiKey = z.output<typeof ApiKey>;
