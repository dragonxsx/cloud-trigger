import { AuthConfig } from '@cloud-trigger/api-contract';
import type { UserManager } from 'oidc-client-ts';
import type { z } from 'zod';

export type AuthConfigDto = z.output<typeof AuthConfig>;

const FALLBACK: AuthConfigDto = { oidc: null, apiKeys: true, anonymous: false };

let config: Promise<AuthConfigDto> | undefined;
let manager: Promise<UserManager | null> | undefined;

const loadConfig = async (): Promise<AuthConfigDto> => {
  const response = await fetch('/api/auth/config');
  const json: unknown = await response.json();

  return AuthConfig.parse(json);
};

export const authConfig = (): Promise<AuthConfigDto> =>
  (config ??= loadConfig().catch(() => {
    config = undefined;

    return FALLBACK;
  }));

const createManager = async (): Promise<UserManager | null> => {
  const { oidc } = await authConfig();
  if (!oidc) {
    return null;
  }
  const { UserManager: Manager, WebStorageStateStore } = await import('oidc-client-ts');

  return new Manager({
    authority: oidc.authority,
    client_id: oidc.clientId,
    scope: oidc.scope,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: `${window.location.origin}/login`,
    response_type: 'code',
    automaticSilentRenew: true,
    userStore: new WebStorageStateStore({ store: window.localStorage }),
  });
};

const userManager = (): Promise<UserManager | null> => (manager ??= createManager());

export async function accessToken(): Promise<string | null> {
  const user = await (await userManager())?.getUser();

  return user && !user.expired ? user.access_token : null;
}

export async function signIn(): Promise<boolean> {
  const current = await userManager();
  if (!current) {
    return false;
  }
  await current.signinRedirect();

  return true;
}

export async function completeSignIn(): Promise<void> {
  await (await userManager())?.signinRedirectCallback();
}

export async function signOut(): Promise<void> {
  await (await userManager())?.removeUser();
}
