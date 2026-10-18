import type { Scope } from '@cloud-trigger/api-contract';
import type { AccessControlProvider, AuthProvider } from '@refinedev/core';
import { z } from 'zod';

import { auth, client } from '../lib/api';
import { isUnauthorized } from '../lib/errors';
import { signIn, signOut } from '../lib/oidc';

const LoginParams = z.union([
  z.object({ method: z.literal('oidc') }),
  z.object({ apiKey: z.string().trim().min(1) }),
]);

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
      return { success: false, error: { name: 'Sign in failed', message: 'Enter an API key' } };
    }
    if ('method' in parsed.data) {
      return (await signIn())
        ? { success: true }
        : { success: false, error: { name: 'Sign in failed', message: 'SSO is not configured' } };
    }
    auth.setApiKey(parsed.data.apiKey);
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
      name:
        identity.via === 'disabled'
          ? 'Local (auth disabled)'
          : identity.via === 'anonymous'
            ? 'Guest (read-only)'
            : identity.subject,
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

const scopeFor = (action: string): Scope =>
  ADMIN_ACTIONS.has(action) ? 'admin' : WRITE_ACTIONS.has(action) ? 'write' : 'read';

export const accessControlProvider: AccessControlProvider = {
  can: async ({ action }) => {
    const needed = scopeFor(action);
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
