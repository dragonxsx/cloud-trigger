import 'reflect-metadata';
import { type Server, createServer } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { SetupAppModule } from '../src/setup-app.module.js';
import {
  createTestApp,
  listen,
  listenNest,
  TEST_ENCRYPTION_KEY,
  testConfig,
} from './support/app.js';
import { type Client, createClient, errorCode } from './support/client.js';
import { tempSqlite } from './support/databases.js';

const TOKEN = 'setup-token-for-tests';
const PASSWORD = 'correct horse battery';
const sqlite = tempSqlite('setup');
let app: INestApplication;
let baseUrl = '';
let issuerServer: Server;
let issuer = '';
let signToken: (claims: Record<string, unknown>) => Promise<string>;
let rootToken = '';

const client = (headers: Record<string, string> = {}, url = baseUrl): Client =>
  createClient(url, headers);
const bearer = (token: string) => client({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  issuerServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/jwks' ? { keys: [jwk] } : { issuer, jwks_uri: `${issuer}/jwks` },
      ),
    );
  });
  issuer = await listen(issuerServer);
  signToken = (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('cloud-trigger')
      .setSubject('sso-user')
      .setExpirationTime('5m')
      .sign(privateKey);

  ({ app } = await createTestApp(testConfig({ ...sqlite.env, SETUP_TOKEN: TOKEN }), {
    auth: false,
  }));
  await app.init();
  baseUrl = await listenNest(app);
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => issuerServer.close(() => resolve()));
  sqlite.cleanup();
});

describe('first-run setup', () => {
  it('reports the auth stage and refuses API calls until setup is done', async () => {
    expect(await client().setup.status({})).toEqual({
      stage: 'auth',
      database: { driver: 'sqlite', issues: [] },
    });
    expect((await client().auth.config({})).setupRequired).toBe(true);
    expect(await errorCode(client().jobs.list({}))).toBe('SETUP_REQUIRED');
    expect((await fetch(`${baseUrl}/mcp`, { method: 'POST' })).status).toBe(503);
    expect(await errorCode(client().setup.verifyToken({ token: 'wrong' }))).toBe('UNAUTHORIZED');
    expect(await client().setup.verifyToken({ token: TOKEN })).toEqual({ ok: true });
  });

  it('tests a database connection and returns the env snippet', async () => {
    const path = sqlite.path('probe.db');
    expect(
      await client().setup.testDatabase({ token: TOKEN, database: { driver: 'sqlite', path } }),
    ).toEqual({ ok: true, error: null, env: { DB_DRIVER: 'sqlite', SQLITE_PATH: path } });
    const unreachable = await client().setup.testDatabase({
      token: TOKEN,
      database: { driver: 'postgres', url: 'postgres://nobody@127.0.0.1:1/none' },
    });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.error).toBeTypeOf('string');
  });

  it('checks OIDC discovery with the setup token', async () => {
    expect(await client().setup.testOidc({ token: TOKEN, issuer })).toEqual({
      ok: true,
      error: null,
      jwksUri: `${issuer}/jwks`,
    });
    expect(await errorCode(client().setup.testOidc({ issuer }))).toBe('UNAUTHORIZED');
  });

  it('rejects settings that would lock everyone out', async () => {
    expect(
      await errorCode(
        client().setup.complete({
          token: TOKEN,
          admin: { username: 'root', password: PASSWORD },
          methods: { local: { enabled: false } },
        }),
      ),
    ).toBe('INVALID_CONFIG');
    expect(
      await errorCode(
        client().setup.complete({
          token: TOKEN,
          admin: { username: 'root', password: 'short' },
          methods: {},
        }),
      ),
    ).toBe('BAD_REQUEST');
  });

  it('completes once, signs the admin in, and then turns the wizard off', async () => {
    const session = await client().setup.complete({
      token: TOKEN,
      admin: { username: 'root', password: PASSWORD },
      methods: {
        oidc: { enabled: true, issuer, audience: 'cloud-trigger', clientId: 'ui' },
      },
    });
    rootToken = session.token;
    expect(await bearer(session.token).auth.me({})).toMatchObject({
      subject: 'user:root',
      name: 'root',
      via: 'local',
      scopes: ['read', 'write', 'admin'],
    });
    expect((await client().setup.status({})).stage).toBe('done');
    expect(await errorCode(client().setup.verifyToken({ token: TOKEN }))).toBe('CONFLICT');
    expect(
      await errorCode(
        client().setup.complete({
          token: TOKEN,
          admin: { username: 'second', password: PASSWORD },
          methods: {},
        }),
      ),
    ).toBe('CONFLICT');
    expect(await client().auth.config({})).toEqual({
      setupRequired: false,
      local: true,
      oidc: {
        authority: issuer,
        clientId: 'ui',
        scope: 'openid profile cloud-trigger:read cloud-trigger:write',
      },
      apiKeys: false,
      anonymous: false,
    });
    expect(await errorCode(client().jobs.list({}))).toBe('UNAUTHORIZED');
  });
});

describe('signing in', () => {
  it('logs in with a password and throttles repeated failures', async () => {
    const session = await client().auth.login({ username: 'ROOT', password: PASSWORD });
    expect((await bearer(session.token).auth.me({})).name).toBe('root');

    const wrong = () => errorCode(client().auth.login({ username: 'root', password: 'nope' }));
    expect(await wrong()).toBe('UNAUTHORIZED');
    expect(await wrong()).toBe('UNAUTHORIZED');
    expect(await wrong()).toBe('UNAUTHORIZED');
    expect(await errorCode(client().auth.login({ username: 'root', password: PASSWORD }))).toBe(
      'TOO_MANY_REQUESTS',
    );
    expect(await errorCode(client().auth.login({ username: 'ghost', password: 'x' }))).toBe(
      'UNAUTHORIZED',
    );
  });

  it('accepts OIDC tokens and maps prefixed scopes', async () => {
    const writer = bearer(await signToken({ scope: 'openid cloud-trigger:write' }));
    expect(await writer.auth.me({})).toMatchObject({
      subject: 'sso-user',
      via: 'oidc',
      scopes: ['read', 'write'],
    });
    const defaults = bearer(await signToken({ preferred_username: 'jo' }));
    expect(await defaults.auth.me({})).toMatchObject({ name: 'jo', scopes: ['read'] });
    expect(await errorCode(bearer('not-a-jwt').auth.me({}))).toBe('UNAUTHORIZED');
  });
});

describe('access administration', () => {
  let admin: Client;

  beforeAll(() => {
    admin = bearer(rootToken);
  });

  it('issues API keys that work once and stop after revocation', async () => {
    const created = await admin.apiKeys.create({ name: 'ci', scopes: ['write'] });
    expect(created.key).toMatch(/^ct_/);
    expect(created).not.toHaveProperty('hash');
    const ci = client({ 'x-api-key': created.key });
    expect((await ci.auth.me({})).scopes).toEqual(['read', 'write']);
    expect(await errorCode(ci.users.list({}))).toBe('FORBIDDEN');
    expect((await client().auth.config({})).apiKeys).toBe(true);
    expect((await admin.apiKeys.list({}))[0]?.lastUsedAt).toBeTypeOf('string');

    expect(await admin.apiKeys.revoke({ id: created.id })).toEqual({ revoked: true });
    expect(await errorCode(ci.auth.me({}))).toBe('UNAUTHORIZED');
  });

  it('manages users, signs out reset accounts and keeps the last admin', async () => {
    const viewer = await admin.users.create({
      username: 'viewer',
      password: PASSWORD,
      scopes: ['read'],
    });
    expect(viewer).not.toHaveProperty('passwordHash');
    expect(
      await errorCode(
        admin.users.create({ username: 'VIEWER', password: PASSWORD, scopes: ['read'] }),
      ),
    ).toBe('CONFLICT');
    const viewerSession = await client().auth.login({ username: 'viewer', password: PASSWORD });
    const asViewer = bearer(viewerSession.token);
    expect((await asViewer.auth.me({})).scopes).toEqual(['read']);

    await admin.users.resetPassword({ id: viewer.id, password: `${PASSWORD}!` });
    expect(await errorCode(asViewer.auth.me({}))).toBe('UNAUTHORIZED');

    const changed = await bearer(
      (await client().auth.login({ username: 'viewer', password: `${PASSWORD}!` })).token,
    ).auth.changePassword({ currentPassword: `${PASSWORD}!`, newPassword: `${PASSWORD}?` });
    expect((await bearer(changed.token).auth.me({})).name).toBe('viewer');

    const page = await admin.users.list({ search: 'ROO' });
    const root = page.items[0];
    if (!root) {
      throw new Error('root user missing');
    }
    const settings = await admin.authSettings.get({});
    const localOnly = await admin.authSettings.update({
      ...settings,
      oidc: { ...settings.oidc, enabled: false },
      expectedVersion: settings.version,
    });
    expect(localOnly.version).toBe(settings.version + 1);
    expect(
      await errorCode(
        admin.users.update({
          id: root.id,
          expectedVersion: root.version,
          scopes: ['read'],
          disabled: false,
        }),
      ),
    ).toBe('INVALID_CONFIG');
    expect(await errorCode(admin.users.delete({ id: root.id }))).toBe('INVALID_CONFIG');
    expect(
      await errorCode(
        admin.authSettings.update({
          ...localOnly,
          local: { ...localOnly.local, enabled: false },
          expectedVersion: localOnly.version,
        }),
      ),
    ).toBe('INVALID_CONFIG');
    expect(await admin.users.delete({ id: viewer.id })).toEqual({ deleted: true });
  });

  it('rotating the session secret signs out every password session', async () => {
    const rotated = await admin.authSettings.rotateSessionSecret({});
    expect(rotated).not.toHaveProperty('sessionSecret');
    expect(await errorCode(admin.auth.me({}))).toBe('UNAUTHORIZED');
  });
});

describe('database stage', () => {
  it('serves only the setup routes while no database is configured', async () => {
    const config = loadConfig({
      DATA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      SETUP_TOKEN: TOKEN,
      PORT: '0',
    });
    const setupApp = await NestFactory.create(
      SetupAppModule.forRoot({
        config,
        pino: pino({ level: 'silent' }),
        issues: [{ path: 'DB_DRIVER', message: 'No database is configured' }],
      }),
      { bodyParser: false, logger: false },
    );
    await setupApp.init();
    const url = await listenNest(setupApp);
    try {
      const anonymous = client({}, url);
      expect(await anonymous.setup.status({})).toEqual({
        stage: 'database',
        database: {
          driver: null,
          issues: [{ path: 'DB_DRIVER', message: 'No database is configured' }],
        },
      });
      const path = sqlite.path('chosen.db');
      expect(
        (await anonymous.setup.testDatabase({ token: TOKEN, database: { driver: 'sqlite', path } }))
          .env,
      ).toEqual({ DB_DRIVER: 'sqlite', SQLITE_PATH: path });
      expect(
        await errorCode(
          anonymous.setup.complete({
            token: TOKEN,
            admin: { username: 'root', password: PASSWORD },
            methods: {},
          }),
        ),
      ).toBe('CONFLICT');
      expect((await fetch(`${url}/api/jobs`)).status).toBe(404);
      expect((await fetch(`${url}/health/ready`)).status).toBe(503);
    } finally {
      await setupApp.close();
    }
  });
});
