import {
  AuthMethods,
  type AuthMethodsInput,
  type AuthSettings,
  type PasswordHasher,
  type Persistence,
  type User,
  type UserId,
  nonAtomicUnitOfWork,
  systemClock,
} from '@cloud-trigger/core';
import { createSqlitePersistence } from '@cloud-trigger/persistence-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { AccessService } from '../src/auth/access-service.js';
import { LoginThrottle } from '../src/auth/login-throttle.js';
import { argon2PasswordHasher } from '../src/auth/passwords.js';
import { resetAdmin } from '../src/auth/reset-admin.js';
import { AuthSettingsCache } from '../src/auth/settings-cache.js';

const PASSWORD = 'correct horse battery';
const ISSUER = 'https://id.example.com';
const hasher: PasswordHasher = {
  hash: (password) => Promise.resolve(`hashed:${password}`),
  verify: (hash, password) => Promise.resolve(hash === `hashed:${password}`),
};
const methods = (input: AuthMethodsInput = {}) => AuthMethods.parse(input);

const opened: Persistence[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((persistence) => persistence.close()));
});

const failOnce = <T>(work: () => Promise<T>): (() => Promise<T>) => {
  let failed = false;

  return () => {
    if (failed) {
      return work();
    }
    failed = true;

    return Promise.reject(new Error('connection reset'));
  };
};

const openStore = async (
  fail: { readonly settingsCreate?: boolean; readonly userInsert?: boolean } = {},
): Promise<Persistence> => {
  const real = createSqlitePersistence({ path: ':memory:' });
  opened.push(real);
  await real.migrate();
  const { authSettings, users } = real;
  let nextSettings: AuthSettings | undefined;
  let nextUser: User | undefined;
  const createSettings = failOnce(() => authSettings.create(required(nextSettings)));
  const insertUser = failOnce(() => users.insert(required(nextUser)));

  return {
    ...real,
    unitOfWork: nonAtomicUnitOfWork,
    authSettings: {
      get: () => authSettings.get(),
      update: (next, expectedVersion) => authSettings.update(next, expectedVersion),
      create: (settings) => {
        nextSettings = settings;

        return fail.settingsCreate ? createSettings() : authSettings.create(settings);
      },
    },
    users: {
      get: (id) => users.get(id),
      findByUsername: (username) => users.findByUsername(username),
      list: (query) => users.list(query),
      update: (next, expectedVersion) => users.update(next, expectedVersion),
      delete: (id) => users.delete(id),
      countActiveAdmins: () => users.countActiveAdmins(),
      insert: (user) => {
        nextUser = user;

        return fail.userInsert ? insertUser() : users.insert(user);
      },
    },
  };
};

const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error('missing value');
  }

  return value;
};

const serviceFor = (persistence: Persistence) =>
  new AccessService({
    persistence,
    settings: new AuthSettingsCache(persistence.authSettings, systemClock),
    hasher,
    throttle: new LoginThrottle(),
    clock: systemClock,
  });

const setUp = async (persistence: Persistence, input: AuthMethodsInput = {}) => {
  const access = serviceFor(persistence);
  (
    await access.completeSetup({
      admin: { username: 'root', password: PASSWORD },
      methods: methods(input),
    })
  )._unsafeUnwrap();

  return access;
};

const addAdmin = async (access: AccessService, username: string): Promise<UserId> =>
  (await access.createUser({ username, password: PASSWORD, scopes: ['admin'] }))._unsafeUnwrap().id;

describe('completeSetup', () => {
  it.each([
    ['the admin insert', { userInsert: true }],
    ['the settings write', { settingsCreate: true }],
  ])('can be retried when %s fails', async (_step, fail) => {
    const persistence = await openStore(fail);
    const access = serviceFor(persistence);
    const admin = { username: 'root', password: PASSWORD };

    await expect(access.completeSetup({ admin, methods: methods() })).rejects.toThrow(
      'connection reset',
    );
    expect(await access.isSetUp()).toBe(false);

    (await access.completeSetup({ admin, methods: methods() }))._unsafeUnwrap();
    expect((await access.login('root', PASSWORD)).isOk()).toBe(true);
    expect(await persistence.users.countActiveAdmins()).toBe(1);
  });

  it('removes its admin when another setup finished first', async () => {
    const persistence = await openStore();
    await setUp(persistence);
    const second = await serviceFor(persistence).completeSetup({
      admin: { username: 'other', password: PASSWORD },
      methods: methods(),
    });

    expect(second._unsafeUnwrapErr().code).toBe('conflict');
    expect(await persistence.users.findByUsername('other')).toBeUndefined();
  });

  it('never takes over an account once setup is done', async () => {
    const persistence = await openStore();
    await setUp(persistence);
    const again = await serviceFor(persistence).completeSetup({
      admin: { username: 'root', password: 'another password' },
      methods: methods(),
    });

    expect(again._unsafeUnwrapErr().code).toBe('conflict');
    expect((await serviceFor(persistence).login('root', PASSWORD)).isOk()).toBe(true);
  });
});

describe('last admin guard', () => {
  it('lets only one of two concurrent admin deletions through', async () => {
    const persistence = await openStore();
    const access = await setUp(persistence);
    const rootId = required(await persistence.users.findByUsername('root')).id;
    const otherId = await addAdmin(access, 'other');

    const results = await Promise.all([access.deleteUser(rootId), access.deleteUser(otherId)]);

    expect(results.filter((result) => result.isOk())).toHaveLength(1);
    expect(await persistence.users.countActiveAdmins()).toBe(1);
  });

  it('serializes demotions with turning OIDC off', async () => {
    const persistence = await openStore();
    const access = await setUp(persistence, { oidc: { enabled: true, issuer: ISSUER } });
    const root = required(await persistence.users.findByUsername('root'));
    const settings = required(await persistence.authSettings.get());

    const [demoted, oidcOff] = await Promise.all([
      access.updateUser({
        id: root.id,
        expectedVersion: root.version,
        scopes: ['read'],
        disabled: false,
      }),
      access.updateSettings(methods(), settings.version),
    ]);

    expect([demoted, oidcOff].filter((result) => result.isOk())).toHaveLength(1);
    const oidcEnabled = (await persistence.authSettings.get())?.oidc.enabled === true;
    expect(oidcEnabled || (await persistence.users.countActiveAdmins()) > 0).toBe(true);
  });

  it('undoes a removal that raced with another server', async () => {
    const persistence = await openStore();
    await setUp(persistence);
    const rootId = required(await persistence.users.findByUsername('root')).id;
    const otherId = await addAdmin(serviceFor(persistence), 'other');

    await Promise.all([
      serviceFor(persistence).deleteUser(rootId),
      serviceFor(persistence).deleteUser(otherId),
    ]);

    expect(await persistence.users.countActiveAdmins()).toBeGreaterThanOrEqual(1);
  });
});

describe('resetAdmin', () => {
  it('turns password sign-in back on so the recovered admin can log in', async () => {
    const persistence = await openStore();
    await setUp(persistence, {
      local: { enabled: false },
      oidc: { enabled: true, issuer: ISSUER },
    });

    const reset = await resetAdmin(persistence, 'rescue');

    expect(reset.enabledLocal).toBe(true);
    expect((await persistence.authSettings.get())?.local.enabled).toBe(true);
    const user = await persistence.users.findByUsername('rescue');
    expect(user?.scopes).toEqual(['admin']);
    expect(await argon2PasswordHasher.verify(user?.passwordHash ?? '', reset.password)).toBe(true);
    expect(await persistence.users.countActiveAdmins()).toBe(2);
  });

  it('leaves settings alone when password sign-in is already on', async () => {
    const persistence = await openStore();
    await setUp(persistence);
    const before = await persistence.authSettings.get();

    expect((await resetAdmin(persistence, 'root')).enabledLocal).toBe(false);
    expect((await persistence.authSettings.get())?.version).toBe(before?.version);
  });
});
