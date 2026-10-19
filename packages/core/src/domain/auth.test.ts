import { describe, expect, it } from 'vitest';

import { AuthMethods, expandScopes, validateAuthMethods } from './auth.js';

const methods = (input: Parameters<typeof AuthMethods.parse>[0]) => AuthMethods.parse(input);
const issuesOf = (input: Parameters<typeof AuthMethods.parse>[0], admins: number) =>
  validateAuthMethods(methods(input), admins).match(
    () => [],
    (error) => error.issues.map((issue) => issue.path),
  );

describe('validateAuthMethods', () => {
  it('accepts local accounts with an active admin', () => {
    expect(issuesOf({}, 1)).toEqual([]);
  });

  it('requires an issuer when OIDC is enabled', () => {
    expect(issuesOf({ oidc: { enabled: true } }, 1)).toEqual(['oidc.issuer']);
  });

  it('refuses to turn off every sign-in method', () => {
    expect(issuesOf({ local: { enabled: false } }, 1)).toEqual(['local.enabled']);
  });

  it('refuses settings that leave no admin able to sign in', () => {
    expect(issuesOf({}, 0)).toEqual(['local.enabled']);
    expect(issuesOf({ oidc: { enabled: true, issuer: 'https://id.example.com' } }, 0)).toEqual([]);
  });
});

describe('expandScopes', () => {
  it('adds implied scopes once', () => {
    expect(expandScopes(['admin', 'read'])).toEqual(['read', 'write', 'admin']);
  });
});
