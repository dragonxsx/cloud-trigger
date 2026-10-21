import { createHash } from 'node:crypto';

import {
  BASE_URL_OPTION,
  type Connected,
  type ConfigIssue,
  type ConnectionSplit,
  type Result,
  type ConnectionTestResult,
  type SecretResolver,
  ResultAsync,
  assertNever,
  defineConnection,
  err,
  errAsync,
  ok,
  okAsync,
  secret,
  toError,
} from '@cloud-trigger/core';
import * as oauth from 'oauth4webapi';
import { request } from 'undici';
import { z } from 'zod';

import { dispatcherFor, errorCode } from '../shared/http-client.js';
import { interpolate, interpolateValues } from '../shared/interpolate.js';
import { pathParamNames } from '../shared/path-params.js';
import { SigningConfig } from '../shared/signing.js';

const ABSOLUTE_HTTP = /^https?:\/\//;
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:|^\/\//i;

export const HttpAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).meta({ title: 'None' }),
  z
    .object({
      type: z.literal('bearer'),
      token: secret(z.string().min(1)).describe('Sent as "Authorization: Bearer <token>".'),
    })
    .meta({ title: 'Bearer token' }),
  z
    .object({
      type: z.literal('basic'),
      username: z.string().min(1),
      password: secret(z.string()),
    })
    .meta({ title: 'Basic' }),
  z
    .object({
      type: z.literal('api_key'),
      in: z.enum(['header', 'query']).default('header'),
      name: z.string().min(1).describe('Header or query parameter name, such as X-API-Key.'),
      value: secret(z.string().min(1)),
    })
    .meta({ title: 'API key' }),
  z
    .object({
      type: z.literal('oauth2_client_credentials'),
      tokenUrl: z.string().regex(ABSOLUTE_HTTP, 'Must start with http:// or https://'),
      clientId: z.string().min(1),
      clientSecret: secret(z.string().min(1)),
      clientAuth: z
        .enum(['basic', 'body'])
        .default('basic')
        .describe('Send the client credentials as HTTP Basic or in the form body.'),
      scope: z.string().optional(),
      audience: z.string().optional(),
    })
    .meta({
      title: 'OAuth 2.0 client credentials',
      description: 'Fetches an access token and caches it until shortly before it expires.',
    }),
]);
export type HttpAuth = z.output<typeof HttpAuth>;

export const HttpConnectionConfig = z.object({
  baseUrl: z
    .string()
    .regex(ABSOLUTE_HTTP, 'Must start with http:// or https://')
    .describe(
      'Endpoint paths are appended to it, keeping its path. May contain {{secret:NAME}} placeholders.',
    ),
  headers: z
    .record(z.string(), z.string())
    .default({})
    .describe('Sent with every request. Values may contain {{secret:NAME}}.'),
  secretHeaders: z
    .record(z.string(), secret(z.string()))
    .default({})
    .describe('Credential headers sent with every request. Shown as *** and kept on edit.'),
  query: z.record(z.string(), z.string()).default({}),
  auth: HttpAuth.default({ type: 'none' }),
  signing: SigningConfig.optional(),
});
export type HttpConnectionConfig = z.output<typeof HttpConnectionConfig>;

export interface HttpFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface PreparedConnection {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly signing: { readonly config: SigningConfig; readonly secret: string } | undefined;
}

const missingSecret = (error: { readonly message: string }): HttpFailure => ({
  code: 'missing_secret',
  message: error.message,
  retryable: false,
});

export const isRelativeUrl = (url: string): boolean => !HAS_SCHEME.test(url);

export function joinUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const [pathname = '', search = ''] = path.split(/\?(.*)/s);
  const suffix = pathname.replace(/^\/+/, '');
  if (suffix !== '') {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix}`;
  }
  for (const [key, value] of new URLSearchParams(search)) {
    url.searchParams.append(key, value);
  }

  return url;
}

export const urlIssues = (
  url: string,
  connection: Connected<HttpConnectionConfig> | undefined,
): ConfigIssue[] => {
  if (connection === undefined) {
    return ABSOLUTE_HTTP.test(url)
      ? []
      : [{ path: 'url', message: 'Must start with http:// or https://, or use a connection' }];
  }

  return isRelativeUrl(url)
    ? []
    : [
        {
          path: 'url',
          message: `Must be a path relative to the "${connection.key}" connection's base URL`,
        },
      ];
};

const SPLIT_URL = /^(https?:\/\/[^/?#]*)(.*)$/s;

export interface SplitUrl {
  readonly baseUrl: string;
  readonly path: string;
  readonly host: string;
  readonly warnings: readonly ConfigIssue[];
}

const hostOf = (authority: string): string =>
  authority
    .replace(/^https?:\/\//, '')
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '');

export function splitHttpUrl(
  url: string,
  baseUrl?: string,
): Result<SplitUrl, readonly ConfigIssue[]> {
  const match = SPLIT_URL.exec(url);
  const authority = match?.[1];
  if (authority === undefined) {
    return err([{ path: 'url', message: 'Only a literal http:// or https:// URL can be split' }]);
  }
  if (pathParamNames(authority).length > 0) {
    return err([{ path: 'url', message: 'The host cannot contain {name} path parameters' }]);
  }
  if (url.includes('#')) {
    return err([{ path: 'url', message: 'Remove the #fragment first' }]);
  }
  const base = baseUrl ?? authority;
  if (base.includes('?')) {
    return err([{ path: BASE_URL_OPTION, message: 'Cannot contain a query string' }]);
  }
  const rest = url.slice(base.length);
  if (!url.startsWith(base) || !(rest === '' || /^[/?]/.test(rest) || base.endsWith('/'))) {
    return err([{ path: BASE_URL_OPTION, message: `Must be a prefix of ${url}` }]);
  }
  if (base.length < authority.length) {
    return err([{ path: BASE_URL_OPTION, message: 'Must include the whole host' }]);
  }
  if (pathParamNames(base).length > 0) {
    return err([
      {
        path: BASE_URL_OPTION,
        message: 'Cannot contain {name} path parameters; keep them in the endpoint URL',
      },
    ]);
  }
  const basePath = base.slice(authority.length);
  if (basePath.endsWith('//')) {
    return err([{ path: BASE_URL_OPTION, message: 'Cannot end with repeated slashes' }]);
  }
  const path = base.endsWith('/') && rest !== '' && !rest.startsWith('?') ? `/${rest}` : rest;
  const [pathname = '', search = ''] = path.split(/\?(.*)/s);
  if (pathname === '/' && basePath !== '' && basePath !== '/') {
    return err([
      { path: BASE_URL_OPTION, message: 'The trailing slash after the base URL would be dropped' },
    ]);
  }
  if (pathname.startsWith('//')) {
    return err([
      {
        path: BASE_URL_OPTION,
        message: 'The repeated slashes after the base URL would be collapsed',
      },
    ]);
  }
  const reencoded = new URLSearchParams(search).toString() !== search;

  return ok({
    baseUrl: base,
    path,
    host: hostOf(authority),
    warnings: reencoded
      ? [{ path: 'url', message: 'The query string will be sent re-encoded' }]
      : [],
  });
}

export function moveHttpCredentials(config: {
  readonly headers: Readonly<Record<string, string>>;
  readonly secretHeaders: Readonly<Record<string, string>>;
}): {
  readonly connectionHeaders: Record<string, string>;
  readonly headers: Record<string, string>;
} {
  const secretNames = new Set(Object.keys(config.secretHeaders).map((name) => name.toLowerCase()));
  const entries = Object.entries(config.headers);

  return {
    connectionHeaders: Object.fromEntries(
      entries.filter(([name]) => secretNames.has(name.toLowerCase())),
    ),
    headers: Object.fromEntries(entries.filter(([name]) => !secretNames.has(name.toLowerCase()))),
  };
}

const MOVED = new Set(['url', 'headers', 'secretHeaders', 'signing']);

export function splitHttpConnection(
  config: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly secretHeaders: Readonly<Record<string, string>>;
  },
  raw: Readonly<Record<string, unknown>>,
  baseUrl: string | undefined,
): Result<ConnectionSplit, readonly ConfigIssue[]> {
  return splitHttpUrl(config.url, baseUrl).map((split) => {
    const { connectionHeaders, headers } = moveHttpCredentials(config);
    const { signing } = raw;
    const rest = Object.fromEntries(Object.entries(raw).filter(([field]) => !MOVED.has(field)));

    return {
      connection: {
        baseUrl: split.baseUrl,
        ...(Object.keys(connectionHeaders).length > 0 && { headers: connectionHeaders }),
        ...(Object.keys(config.secretHeaders).length > 0 && {
          secretHeaders: config.secretHeaders,
        }),
        ...(signing !== undefined && { signing }),
      },
      config: {
        ...rest,
        url: split.path,
        ...(Object.keys(headers).length > 0 && { headers }),
      },
      suggestedName: split.host,
      warnings: split.warnings,
    };
  });
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

const REFRESH_EARLY_MS = 30_000;
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;
const tokens = new Map<string, Promise<CachedToken>>();

type OAuthConfig = Extract<HttpAuth, { type: 'oauth2_client_credentials' }>;

async function fetchToken(
  auth: OAuthConfig,
  clientSecret: string,
  now: Date,
  signal: AbortSignal,
): Promise<CachedToken> {
  const as: oauth.AuthorizationServer = { issuer: auth.tokenUrl, token_endpoint: auth.tokenUrl };
  const client: oauth.Client = { client_id: auth.clientId };
  const clientAuth =
    auth.clientAuth === 'basic'
      ? oauth.ClientSecretBasic(clientSecret)
      : oauth.ClientSecretPost(clientSecret);
  const parameters: Record<string, string> = {
    ...(auth.scope !== undefined && { scope: auth.scope }),
    ...(auth.audience !== undefined && { audience: auth.audience }),
  };
  const response = await oauth.clientCredentialsGrantRequest(as, client, clientAuth, parameters, {
    signal,
    [oauth.allowInsecureRequests]: auth.tokenUrl.startsWith('http:'),
  });
  const body = await oauth.processClientCredentialsResponse(as, client, response);
  const ttlMs = body.expires_in === undefined ? DEFAULT_TOKEN_TTL_MS : body.expires_in * 1_000;

  return { token: body.access_token, expiresAt: now.getTime() + ttlMs - REFRESH_EARLY_MS };
}

const tokenFailure = (error: unknown): HttpFailure => {
  const status = error instanceof oauth.ResponseBodyError ? error.status : undefined;

  return {
    code: 'auth_failed',
    message: `OAuth token request failed: ${toError(error).message}`,
    retryable: status === undefined || status >= 500 || status === 429,
  };
};

function accessToken(
  auth: OAuthConfig,
  clientSecret: string,
  p: { cacheKey: string | undefined; now: Date; signal: AbortSignal },
): ResultAsync<string, HttpFailure> {
  // Every grant parameter is part of the identity: environment overlays share the
  // connection key and version but may change audience or scope.
  const credentials = createHash('sha256')
    .update(
      JSON.stringify([
        auth.tokenUrl,
        auth.clientId,
        clientSecret,
        auth.clientAuth,
        auth.scope ?? null,
        auth.audience ?? null,
      ]),
    )
    .digest('hex');
  const key = p.cacheKey === undefined ? undefined : `${p.cacheKey}|${credentials}`;
  const cached = key === undefined ? undefined : tokens.get(key);
  const pending = (async () => {
    const hit = cached ? await cached.catch(() => undefined) : undefined;
    if (hit && hit.expiresAt > p.now.getTime()) {
      return hit;
    }
    const fresh = fetchToken(auth, clientSecret, p.now, p.signal);
    if (key !== undefined) {
      tokens.set(key, fresh);
      void fresh.catch(() => tokens.delete(key));
    }

    return fresh;
  })();

  return ResultAsync.fromPromise(pending, tokenFailure).map((t) => t.token);
}

export const clearHttpTokenCache = (): void => {
  tokens.clear();
};

function authHeaders(
  auth: HttpAuth,
  secrets: SecretResolver,
  p: { cacheKey: string | undefined; now: Date; signal: AbortSignal },
): ResultAsync<{ headers: Record<string, string>; query: Record<string, string> }, HttpFailure> {
  const none = { headers: {}, query: {} };
  switch (auth.type) {
    case 'none':
      return okAsync(none);
    case 'bearer':
      return interpolate(secrets, auth.token)
        .mapErr(missingSecret)
        .map((token) => ({ ...none, headers: { authorization: `Bearer ${token}` } }));
    case 'basic':
      return interpolate(secrets, auth.password)
        .mapErr(missingSecret)
        .map((password) => ({
          ...none,
          headers: {
            authorization: `Basic ${Buffer.from(`${auth.username}:${password}`).toString('base64')}`,
          },
        }));
    case 'api_key':
      return interpolate(secrets, auth.value)
        .mapErr(missingSecret)
        .map((value) =>
          auth.in === 'header'
            ? { ...none, headers: { [auth.name]: value } }
            : { ...none, query: { [auth.name]: value } },
        );
    case 'oauth2_client_credentials':
      return interpolate(secrets, auth.clientSecret)
        .mapErr(missingSecret)
        .andThen((clientSecret) => accessToken(auth, clientSecret, p))
        .map((token) => ({ ...none, headers: { authorization: `Bearer ${token}` } }));
    default:
      return assertNever(auth);
  }
}

export function prepareConnection(
  connection: Connected<HttpConnectionConfig>,
  secrets: SecretResolver,
  p: { now: Date; signal: AbortSignal; cache?: boolean },
): ResultAsync<PreparedConnection, HttpFailure> {
  const { config } = connection;
  const cacheKey = p.cache === false ? undefined : `${connection.key}@${connection.version}`;

  return ResultAsync.combine([
    interpolate(secrets, config.baseUrl),
    interpolateValues(secrets, config.headers),
    interpolateValues(secrets, config.secretHeaders),
    config.signing ? interpolate(secrets, config.signing.secret) : okAsync(undefined),
  ] as const)
    .mapErr(missingSecret)
    .andThen(([baseUrl, headers, secretHeaders, signingSecret]) =>
      authHeaders(config.auth, secrets, { cacheKey, now: p.now, signal: p.signal }).map((auth) => ({
        baseUrl,
        headers: { ...headers, ...secretHeaders, ...auth.headers },
        query: { ...config.query, ...auth.query },
        signing:
          config.signing && signingSecret !== undefined
            ? { config: config.signing, secret: signingSecret }
            : undefined,
      })),
    );
}

export function requestUrl(
  rawUrl: string,
  prepared: PreparedConnection | undefined,
  query: Readonly<Record<string, string>>,
): ResultAsync<URL, HttpFailure> {
  try {
    const url = prepared ? joinUrl(prepared.baseUrl, rawUrl) : new URL(rawUrl);
    for (const [k, v] of Object.entries({ ...prepared?.query, ...query })) {
      url.searchParams.set(k, v);
    }

    return okAsync(url);
  } catch (error: unknown) {
    return errAsync({ code: 'invalid_url', message: toError(error).message, retryable: false });
  }
}

export function prepareRequest(
  rawUrl: string,
  query: Readonly<Record<string, string>>,
  connection: Connected<HttpConnectionConfig> | undefined,
  secrets: SecretResolver,
  p: { now: Date; signal: AbortSignal },
): ResultAsync<{ url: URL; connection: PreparedConnection | undefined }, HttpFailure> {
  const prepared: ResultAsync<PreparedConnection | undefined, HttpFailure> = connection
    ? prepareConnection(connection, secrets, p)
    : okAsync(undefined);

  return prepared.andThen((c) =>
    requestUrl(rawUrl, c, query).map((url) => ({ url, connection: c })),
  );
}

export const httpConnection = defineConnection({
  type: 'http',
  displayName: 'HTTP API',
  description: 'A REST or GraphQL API: base URL, credentials and headers shared by its endpoints.',
  configSchema: HttpConnectionConfig,
  address: (config) => config.baseUrl.replace(/\/+$/, ''),
  async test(config, { secrets, signal, now }): Promise<ConnectionTestResult> {
    const prepared = await prepareConnection({ key: 'test', version: 0, config }, secrets, {
      now,
      signal,
      cache: false,
    }).andThen((p) => requestUrl('', p, {}).map((url) => ({ url, headers: p.headers })));
    if (prepared.isErr()) {
      return err({ message: prepared.error.message });
    }
    const { url, headers } = prepared.value;
    const call = (method: 'HEAD' | 'GET') =>
      request(url, {
        method,
        headers: { 'user-agent': 'cloud-trigger', ...headers },
        signal,
        dispatcher: dispatcherFor(0),
      }).then(async (response) => {
        await response.body.dump();

        return response.statusCode;
      });
    try {
      const head = await call('HEAD');
      const status = head === 405 || head === 501 ? await call('GET') : head;
      if (status === 401 || status === 403) {
        return err({ message: `${url.origin} rejected the credentials (HTTP ${status})` });
      }

      return status >= 500
        ? err({ message: `${url.origin} answered HTTP ${status}` })
        : ok({ message: `${url.origin} answered HTTP ${status}` });
    } catch (error: unknown) {
      return err({ message: `${errorCode(error) ?? 'network_error'}: ${toError(error).message}` });
    }
  },
});
