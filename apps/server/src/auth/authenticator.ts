import { createHash, timingSafeEqual } from 'node:crypto';

import { Scope } from '@cloud-trigger/api-contract';
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

import type { AppConfig } from '../config/config.js';

export interface Principal {
  readonly subject: string;
  readonly via: 'oidc' | 'api_key' | 'anonymous' | 'disabled';
  readonly scopes: readonly Scope[];
}

const IMPLIED: Record<Scope, readonly Scope[]> = {
  read: ['read'],
  write: ['read', 'write'],
  admin: ['read', 'write', 'admin'],
};
const expand = (scopes: readonly Scope[]): Scope[] => [
  ...new Set(scopes.flatMap((s) => IMPLIED[s])),
];

export const hasScope = (principal: Principal, required: Scope): boolean =>
  principal.scopes.includes(required);

const Discovery = z.object({ jwks_uri: z.url() });
const ScopeClaim = z
  .union([z.string().transform((s) => s.split(' ')), z.array(z.string())])
  .optional();

export type AuthFailure = 'missing' | 'invalid';

export class Authenticator {
  #jwks: Promise<JWTVerifyGetKey> | undefined;

  constructor(private readonly config: AppConfig) {}

  async authenticate(headers: Headers | undefined): Promise<Principal | AuthFailure> {
    if (this.config.AUTH_DISABLED) {
      return { subject: 'anonymous', via: 'disabled', scopes: expand(['admin']) };
    }

    const apiKey = headers?.get('x-api-key');
    if (apiKey) {
      return this.#fromApiKey(apiKey) ?? 'invalid';
    }

    const bearerToken = headers?.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (bearerToken) {
      return (await this.#fromJwt(bearerToken)) ?? 'invalid';
    }

    return this.config.ANONYMOUS_SCOPES.length > 0
      ? { subject: 'anonymous', via: 'anonymous', scopes: expand(this.config.ANONYMOUS_SCOPES) }
      : 'missing';
  }

  #fromApiKey(key: string): Principal | undefined {
    const digest = createHash('sha256').update(key).digest();
    const match = this.config.API_KEYS.find((k) =>
      timingSafeEqual(Buffer.from(k.hash, 'hex'), digest),
    );

    return (
      match && { subject: `api-key:${match.name}`, via: 'api_key', scopes: expand(match.scopes) }
    );
  }

  async #fromJwt(token: string): Promise<Principal | undefined> {
    const issuer = this.config.OIDC_ISSUER;
    if (!issuer) {
      return undefined;
    }
    try {
      const { payload } = await jwtVerify(token, await this.#keySet(issuer), {
        issuer,
        ...(this.config.OIDC_AUDIENCE !== undefined && { audience: this.config.OIDC_AUDIENCE }),
      });
      const claimed = ScopeClaim.catch(undefined).parse(payload['scope'] ?? payload['scp']) ?? [];
      const prefix = this.config.OIDC_SCOPE_PREFIX;
      const scopes = claimed.flatMap((s): Scope[] => {
        const scope = s.startsWith(prefix) ? Scope.safeParse(s.slice(prefix.length)) : undefined;

        return scope?.success ? [scope.data] : [];
      });

      return {
        subject: payload.sub ?? 'unknown',
        via: 'oidc',
        scopes: expand(scopes.length > 0 ? scopes : this.config.OIDC_DEFAULT_SCOPES),
      };
    } catch {
      return undefined;
    }
  }

  #keySet(issuer: string): Promise<JWTVerifyGetKey> {
    this.#jwks ??= (async () => {
      const jwksUri =
        this.config.OIDC_JWKS_URI ??
        Discovery.parse(
          await (
            await fetch(
              new URL('.well-known/openid-configuration', `${issuer.replace(/\/$/, '')}/`),
            )
          ).json(),
        ).jwks_uri;

      return createRemoteJWKSet(new URL(jwksUri));
    })();
    this.#jwks.catch(() => {
      this.#jwks = undefined;
    });

    return this.#jwks;
  }
}
