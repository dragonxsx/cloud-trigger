import type { Scope } from '@cloud-trigger/api-contract';
import type { AccessControlProvider, AuthProvider } from '@refinedev/core';
import { z } from 'zod';

import { auth, client } from '../lib/api';
import { errorMessage, isUnauthorized } from '../lib/errors';
import { signIn, signOut } from '../lib/oidc';
import { passwordSession } from '../lib/session';

const LoginParams = z.union([
  z.object({ method: z.literal('oidc') }),
  z.object({ username: z.string().trim().min(1), password: z.string().min(1) }),
  z.object({ apiKey: z.string().trim().min(1) }),
]);

export const startPasswordSession = (session: { token: string; expiresAt: string }): void => {
  auth.setApiKey(null);
  passwordSession.set(session);
  me = undefined;
};

let me: Promise<Awaited<ReturnType<typeof client.auth.me>>> | undefined;
const whoAmI = () =>
  (me ??= client.auth.me({}).catch((error: unknown) => {
    me = undefined;
    throw error;
  }));

export const authProvider: AuthProvider = {
  login: async (params: unknown) => {
    const parsed = LoginParams.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: { name: 'Sign in failed', message: 'Fill in every field' } };
    }
    const credentials = parsed.data;
    if ('method' in credentials) {
      return (await signIn())
        ? { success: true }
        : { success: false, error: { name: 'Sign in failed', message: 'SSO is not configured' } };
    }
    if ('username' in credentials) {
      try {
        startPasswordSession(
          await client.auth.login({
            username: credentials.username,
            password: credentials.password,
          }),
        );

        return { success: true, redirectTo: '/' };
      } catch (error: unknown) {
        return { success: false, error: { name: 'Sign in failed', message: errorMessage(error) } };
      }
    }
    passwordSession.set(null);
    auth.setApiKey(credentials.apiKey);
    me = undefined;
    try {
      await whoAmI();

      return { success: true, redirectTo: '/' };
    } catch {
      auth.setApiKey(null);

      return {
        success: false,
        error: {
          name: 'Sign in failed',
          message: 'That key was not accepted. Check it and try again.',
        },
      };
    }
  },
  logout: async () => {
    auth.setApiKey(null);
    passwordSession.set(null);
    await signOut();
    me = undefined;

    return { success: true, redirectTo: '/login' };
  },
  check: async () => {
    try {
      await whoAmI();

      return { authenticated: true };
    } catch {
      return { authenticated: false, redirectTo: '/login', logout: true };
    }
  },
  onError: async (error: unknown) =>
    isUnauthorized(error) || z.object({ statusCode: z.literal(401) }).safeParse(error).success
      ? { logout: true, redirectTo: '/login' }
      : {},
  getPermissions: async () => (await whoAmI()).scopes,
  getIdentity: async () => {
    const identity = await whoAmI();

    return {
      id: identity.subject,
      via: identity.via,
      name: identity.via === 'anonymous' ? 'Guest' : identity.name,
    };
  },
};

const WRITE_ACTIONS = new Set([
  'create',
  'edit',
  'delete',
  'clone',
  'run',
  'pause',
  'resume',
  'cancel',
  'replay',
  'acknowledge',
  'backfill',
]);
const ADMIN_ACTIONS = new Set(['import', 'export']);
const ADMIN_RESOURCES = new Set(['settings', 'users', 'api-keys', 'auth-settings']);

const scopeFor = (action: string, resource: string | undefined): Scope =>
  ADMIN_ACTIONS.has(action) || (resource !== undefined && ADMIN_RESOURCES.has(resource))
    ? 'admin'
    : WRITE_ACTIONS.has(action)
      ? 'write'
      : 'read';

export const accessControlProvider: AccessControlProvider = {
  can: async ({ action, resource }) => {
    const needed = scopeFor(action, resource);
    try {
      const scopes = (await whoAmI()).scopes;

      return scopes.includes(needed)
        ? { can: true }
        : { can: false, reason: `Requires the ${needed} scope` };
    } catch {
      return { can: false };
    }
  },
  options: { buttons: { enableAccessControl: true, hideIfUnauthorized: true } },
};
