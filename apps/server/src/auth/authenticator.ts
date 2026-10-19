import {
  type ApiKeyRepository,
  type AuthSettings,
  type Clock,
  type OidcAuthSettings,
  Scope,
  type UserId,
  type UserRepository,
  expandScopes,
} from '@cloud-trigger/core';
import { type JWTVerifyGetKey, createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { z } from 'zod';

import { hashApiKey } from './api-keys.js';
import { LOCAL_ISSUER, verifySession } from './sessions.js';
import type { AuthSettingsCache } from './settings-cache.js';

export interface Principal {
  readonly subject: string;
  readonly name: string;
  readonly via: 'local' | 'oidc' | 'api_key' | 'anonymous';
  readonly scopes: readonly Scope[];
  readonly userId?: UserId | undefined;
}

export const hasScope = (principal: Principal, required: Scope): boolean =>
  principal.scopes.includes(required);

const Discovery = z.object({ jwks_uri: z.url() });
const ScopeClaim = z
  .union([z.string().transform((s) => s.split(' ')), z.array(z.string())])
  .optional();
const NameClaim = z.string().min(1).optional().catch(undefined);

const TOUCH_INTERVAL_MS = 60_000;

export type AuthFailure = 'missing' | 'invalid' | 'setup_required';

export interface Authenticate {
  readonly authenticate: (headers: Headers | undefined) => Promise<Principal | AuthFailure>;
}

export const isAuthFailure = (result: Principal | AuthFailure): result is AuthFailure =>
  typeof result === 'string';

export async function fetchJwksUri(issuer: string): Promise<string> {
  const url = new URL('.well-known/openid-configuration', `${issuer.replace(/\/$/, '')}/`);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(
    (error: unknown) => {
      throw new Error(
        `Could not reach ${url.href}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    },
  );
  if (!response.ok) {
    throw new Error(`${url.href} returned HTTP ${response.status}`);
  }

  return Discovery.parse(await response.json()).jwks_uri;
}

export interface AuthenticatorDeps {
  readonly settings: AuthSettingsCache;
  readonly users: UserRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly clock: Clock;
}

export class Authenticator implements Authenticate {
  #jwks: { readonly key: string; readonly keySet: Promise<JWTVerifyGetKey> } | undefined;

  constructor(private readonly deps: AuthenticatorDeps) {}

  async authenticate(headers: Headers | undefined): Promise<Principal | AuthFailure> {
    const settings = await this.deps.settings.get();
    if (!settings) {
      return 'setup_required';
    }

    const apiKey = headers?.get('x-api-key');
    if (apiKey) {
      return (await this.#fromApiKey(apiKey)) ?? 'invalid';
    }

    const bearerToken = headers?.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (bearerToken) {
      return (await this.#fromBearer(bearerToken, settings)) ?? 'invalid';
    }

    return settings.anonymous.scopes.length > 0
      ? {
          subject: 'anonymous',
          name: 'Guest',
          via: 'anonymous',
          scopes: expandScopes(settings.anonymous.scopes),
        }
      : 'missing';
  }

  async #fromApiKey(key: string): Promise<Principal | undefined> {
    const match = await this.deps.apiKeys.findByHash(hashApiKey(key));
    if (!match || match.revokedAt !== undefined) {
      return undefined;
    }
    const now = this.deps.clock.now();
    if (
      match.lastUsedAt === undefined ||
      now.getTime() - match.lastUsedAt.getTime() > TOUCH_INTERVAL_MS
    ) {
      await this.deps.apiKeys.touch(match.id, now);
    }

    return {
      subject: `api-key:${match.name}`,
      name: match.name,
      via: 'api_key',
      scopes: expandScopes(match.scopes),
    };
  }

  #fromBearer(token: string, settings: AuthSettings): Promise<Principal | undefined> {
    let issuer: string | undefined;
    try {
      issuer = decodeJwt(token).iss;
    } catch {
      return Promise.resolve(undefined);
    }
    if (issuer === LOCAL_ISSUER) {
      return settings.local.enabled
        ? this.#fromSession(token, settings)
        : Promise.resolve(undefined);
    }

    return settings.oidc.enabled
      ? this.#fromOidc(token, settings.oidc)
      : Promise.resolve(undefined);
  }

  async #fromSession(token: string, settings: AuthSettings): Promise<Principal | undefined> {
    const claims = await verifySession(token, settings, this.deps.clock.now());
    const user = claims && (await this.deps.users.get(claims.sub));
    if (!claims || !user || user.disabled || user.tokenVersion !== claims.ver) {
      return undefined;
    }

    return {
      subject: `user:${user.username}`,
      name: user.username,
      via: 'local',
      scopes: expandScopes(user.scopes),
      userId: user.id,
    };
  }

  async #fromOidc(token: string, oidc: OidcAuthSettings): Promise<Principal | undefined> {
    const issuer = oidc.issuer;
    if (issuer === undefined) {
      return undefined;
    }
    try {
      const { payload } = await jwtVerify(token, await this.#keySet(issuer, oidc.jwksUri), {
        issuer,
        ...(oidc.audience !== undefined && { audience: oidc.audience }),
        currentDate: this.deps.clock.now(),
      });
      const claimed = ScopeClaim.catch(undefined).parse(payload['scope'] ?? payload['scp']) ?? [];
      const scopes = claimed.flatMap((s): Scope[] => {
        const scope = s.startsWith(oidc.scopePrefix)
          ? Scope.safeParse(s.slice(oidc.scopePrefix.length))
          : undefined;

        return scope?.success ? [scope.data] : [];
      });
      const subject = payload.sub ?? 'unknown';

      return {
        subject,
        name:
          NameClaim.parse(payload['preferred_username']) ??
          NameClaim.parse(payload['email']) ??
          subject,
        via: 'oidc',
        scopes: expandScopes(scopes.length > 0 ? scopes : oidc.defaultScopes),
      };
    } catch {
      return undefined;
    }
  }

  #keySet(issuer: string, jwksUri: string | undefined): Promise<JWTVerifyGetKey> {
    const key = `${issuer} ${jwksUri ?? ''}`;
    if (this.#jwks?.key !== key) {
      const keySet = (async () =>
        createRemoteJWKSet(new URL(jwksUri ?? (await fetchJwksUri(issuer)))))();
      keySet.catch(() => {
        if (this.#jwks?.keySet === keySet) {
          this.#jwks = undefined;
        }
      });
      this.#jwks = { key, keySet };
    }

    return this.#jwks.keySet;
  }
}
