import {
  type ApiKey,
  type ApiKeyId,
  type AuthMethods,
  type AuthSettings,
  type Clock,
  type ConfigError,
  type ConflictError,
  type DomainError,
  type NotFoundError,
  type Page,
  type PasswordHasher,
  type Persistence,
  type Result,
  type Scope,
  type User,
  type UserId,
  type UserQuery,
  type VersionConflictError,
  Mutex,
  err,
  isActiveAdmin,
  newApiKeyId,
  newUserId,
  ok,
  validateAuthMethods,
} from '@cloud-trigger/core';

import { generateApiKey, generateSessionSecret } from './api-keys.js';
import type { Principal } from './authenticator.js';
import type { LoginThrottle } from './login-throttle.js';
import { type IssuedSession, issueSession } from './sessions.js';
import type { AuthSettingsCache } from './settings-cache.js';

export type SetupRequiredError = DomainError<'setup_required'>;
export type InvalidCredentialsError = DomainError<'invalid_credentials'>;
export type ThrottledError = DomainError<'throttled'>;

export interface AccessServiceDeps {
  readonly persistence: Persistence;
  readonly settings: AuthSettingsCache;
  readonly hasher: PasswordHasher;
  readonly throttle: LoginThrottle;
  readonly clock: Clock;
}

const SETUP_REQUIRED: SetupRequiredError = {
  code: 'setup_required',
  message: 'Finish the setup wizard first',
};
const BAD_CREDENTIALS: InvalidCredentialsError = {
  code: 'invalid_credentials',
  message: 'Wrong username or password',
};
const lastAdmin = (): ConfigError => ({
  code: 'invalid_config',
  message: 'This would leave no admin who can sign in',
  issues: [{ path: 'scopes', message: 'Keep at least one active admin, or enable OIDC' }],
});

export interface CreatedKey {
  readonly apiKey: ApiKey;
  readonly key: string;
}

export class AccessService {
  #dummyHash: Promise<string> | undefined;
  readonly #adminChanges = new Mutex();

  constructor(private readonly deps: AccessServiceDeps) {}

  async isSetUp(): Promise<boolean> {
    return (await this.deps.settings.get()) !== undefined;
  }

  async completeSetup(p: {
    readonly admin: { readonly username: string; readonly password: string };
    readonly methods: AuthMethods;
  }): Promise<Result<IssuedSession, ConflictError | ConfigError>> {
    const validated = validateAuthMethods(p.methods, 1);
    if (validated.isErr()) {
      return err(validated.error);
    }
    const now = this.deps.clock.now();
    const settings: AuthSettings = {
      ...validated.value,
      version: 1,
      sessionSecret: generateSessionSecret(),
      completedAt: now,
      updatedAt: now,
    };
    const admin: User = {
      id: newUserId(),
      username: p.admin.username,
      passwordHash: await this.deps.hasher.hash(p.admin.password),
      scopes: ['admin'],
      disabled: false,
      tokenVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    };
    const { authSettings, users, unitOfWork } = this.deps.persistence;
    const created = await unitOfWork.transaction(async () => {
      const claimed = await this.#claimSetupAdmin(admin);
      if (claimed.isErr()) {
        return err(claimed.error);
      }
      const saved = await authSettings.create(settings);
      if (saved.isErr()) {
        if (!claimed.value.adopted) {
          await users.delete(admin.id);
        }

        return err(saved.error);
      }

      return ok({ settings: saved.value, admin: claimed.value.user });
    });
    if (created.isErr()) {
      return err(created.error);
    }
    this.deps.settings.set(created.value.settings);

    return ok(await issueSession(created.value.admin, created.value.settings, now));
  }

  async login(
    username: string,
    password: string,
  ): Promise<Result<IssuedSession, SetupRequiredError | InvalidCredentialsError | ThrottledError>> {
    const settings = await this.deps.settings.get();
    if (!settings) {
      return err(SETUP_REQUIRED);
    }
    const now = this.deps.clock.now();
    const waitMs = this.deps.throttle.retryAfterMs(username, now);
    if (waitMs > 0) {
      return err({
        code: 'throttled',
        message: `Too many failed attempts; try again in ${Math.ceil(waitMs / 1_000)} s`,
      });
    }
    const user = settings.local.enabled
      ? await this.deps.persistence.users.findByUsername(username)
      : undefined;
    const valid = await this.deps.hasher.verify(
      user?.passwordHash ?? (await this.#placeholderHash()),
      password,
    );
    if (!user || !valid || user.disabled) {
      this.deps.throttle.recordFailure(username, now);

      return err(BAD_CREDENTIALS);
    }
    this.deps.throttle.recordSuccess(username);
    const updated = await this.deps.persistence.users.update(
      { ...user, lastLoginAt: now, version: user.version + 1 },
      user.version,
    );

    return ok(await issueSession(updated.unwrapOr(user), settings, now));
  }

  async changePassword(
    principal: Principal,
    currentPassword: string,
    newPassword: string,
  ): Promise<
    Result<
      IssuedSession,
      SetupRequiredError | InvalidCredentialsError | NotFoundError | VersionConflictError
    >
  > {
    const settings = await this.deps.settings.get();
    if (!settings) {
      return err(SETUP_REQUIRED);
    }
    const user = principal.userId && (await this.deps.persistence.users.get(principal.userId));
    if (!user) {
      return err({ code: 'not_found', message: 'Only password accounts have a password' });
    }
    if (!(await this.deps.hasher.verify(user.passwordHash, currentPassword))) {
      return err({ code: 'invalid_credentials', message: 'The current password is wrong' });
    }
    const now = this.deps.clock.now();
    const updated = await this.deps.persistence.users.update(
      {
        ...user,
        passwordHash: await this.deps.hasher.hash(newPassword),
        tokenVersion: user.tokenVersion + 1,
        version: user.version + 1,
        updatedAt: now,
      },
      user.version,
    );
    if (updated.isErr()) {
      return err(updated.error);
    }

    return ok(await issueSession(updated.value, settings, now));
  }

  async getSettings(): Promise<Result<AuthSettings, SetupRequiredError>> {
    const settings = await this.deps.persistence.authSettings.get();

    return settings ? ok(settings) : err(SETUP_REQUIRED);
  }

  updateSettings(
    methods: AuthMethods,
    expectedVersion: number,
  ): Promise<Result<AuthSettings, SetupRequiredError | ConfigError | VersionConflictError>> {
    return this.#adminChanges.lock(async () => {
      const validated = validateAuthMethods(
        methods,
        await this.deps.persistence.users.countActiveAdmins(),
      );
      if (validated.isErr()) {
        return err(validated.error);
      }
      let previous: AuthSettings | undefined;
      const saved = await this.#changeSettings(expectedVersion, (current) => {
        previous = current;

        return { ...current, ...validated.value };
      });
      if (saved.isErr() || !previous || (await this.#adminCanSignIn(saved.value))) {
        return saved;
      }
      const restored = previous;
      await this.#changeSettings(saved.value.version, (current) => ({
        ...current,
        local: restored.local,
        oidc: restored.oidc,
        anonymous: restored.anonymous,
      }));

      return err(lastAdmin());
    });
  }

  async rotateSessionSecret(): Promise<
    Result<AuthSettings, SetupRequiredError | VersionConflictError>
  > {
    const current = await this.getSettings();
    if (current.isErr()) {
      return err(current.error);
    }

    return this.#changeSettings(current.value.version, (settings) => ({
      ...settings,
      sessionSecret: generateSessionSecret(),
    }));
  }

  listUsers(query: UserQuery): Promise<Page<User>> {
    return this.deps.persistence.users.list(query);
  }

  async getUser(id: UserId): Promise<Result<User, NotFoundError>> {
    const user = await this.deps.persistence.users.get(id);

    return user ? ok(user) : err({ code: 'not_found', message: `User ${id} not found` });
  }

  async createUser(p: {
    readonly username: string;
    readonly password: string;
    readonly scopes: readonly Scope[];
  }): Promise<Result<User, ConflictError>> {
    const now = this.deps.clock.now();

    return this.deps.persistence.users.insert({
      id: newUserId(),
      username: p.username,
      passwordHash: await this.deps.hasher.hash(p.password),
      scopes: [...p.scopes],
      disabled: false,
      tokenVersion: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  async updateUser(p: {
    readonly id: UserId;
    readonly expectedVersion: number;
    readonly scopes: readonly Scope[];
    readonly disabled: boolean;
  }): Promise<Result<User, NotFoundError | VersionConflictError | ConfigError>> {
    const current = await this.getUser(p.id);
    if (current.isErr()) {
      return err(current.error);
    }
    const user = current.value;
    const next: User = {
      ...user,
      scopes: [...p.scopes],
      disabled: p.disabled,
      tokenVersion: p.disabled && !user.disabled ? user.tokenVersion + 1 : user.tokenVersion,
      version: p.expectedVersion + 1,
      updatedAt: this.deps.clock.now(),
    };
    const { users } = this.deps.persistence;
    if (!isActiveAdmin(user) || isActiveAdmin(next)) {
      return users.update(next, p.expectedVersion);
    }

    return this.#adminChanges.lock(async () => {
      if (await this.#isLastAdmin()) {
        return err(lastAdmin());
      }
      const updated = await users.update(next, p.expectedVersion);
      if (updated.isErr() || (await this.#adminCanSignIn())) {
        return updated;
      }
      await users.update(
        { ...user, tokenVersion: next.tokenVersion, version: next.version + 1 },
        next.version,
      );

      return err(lastAdmin());
    });
  }

  async deleteUser(id: UserId): Promise<Result<boolean, ConfigError>> {
    const { users } = this.deps.persistence;
    const user = await users.get(id);
    if (!user) {
      return ok(false);
    }
    if (!isActiveAdmin(user)) {
      return ok(await users.delete(id));
    }

    return this.#adminChanges.lock(async () => {
      if (await this.#isLastAdmin()) {
        return err(lastAdmin());
      }
      const deleted = await users.delete(id);
      if (!deleted || (await this.#adminCanSignIn())) {
        return ok(deleted);
      }
      await users.insert(user);

      return err(lastAdmin());
    });
  }

  async resetPassword(
    id: UserId,
    password: string,
  ): Promise<Result<User, NotFoundError | VersionConflictError>> {
    const current = await this.getUser(id);
    if (current.isErr()) {
      return err(current.error);
    }
    const user = current.value;

    return this.deps.persistence.users.update(
      {
        ...user,
        passwordHash: await this.deps.hasher.hash(password),
        tokenVersion: user.tokenVersion + 1,
        version: user.version + 1,
        updatedAt: this.deps.clock.now(),
      },
      user.version,
    );
  }

  listApiKeys(): Promise<readonly ApiKey[]> {
    return this.deps.persistence.apiKeys.list();
  }

  async createApiKey(p: {
    readonly name: string;
    readonly scopes: readonly Scope[];
  }): Promise<Result<CreatedKey, ConflictError>> {
    const generated = generateApiKey();
    const inserted = await this.deps.persistence.apiKeys.insert({
      id: newApiKeyId(),
      name: p.name,
      hash: generated.hash,
      prefix: generated.prefix,
      scopes: [...p.scopes],
      createdAt: this.deps.clock.now(),
    });

    return inserted.map((apiKey) => ({ apiKey, key: generated.key }));
  }

  revokeApiKey(id: ApiKeyId): Promise<boolean> {
    return this.deps.persistence.apiKeys.revoke(id, this.deps.clock.now());
  }

  async #isLastAdmin(): Promise<boolean> {
    const settings = await this.deps.persistence.authSettings.get();

    return (
      settings?.oidc.enabled !== true &&
      (await this.deps.persistence.users.countActiveAdmins()) <= 1
    );
  }

  async #adminCanSignIn(settings?: AuthSettings): Promise<boolean> {
    const current = settings ?? (await this.deps.persistence.authSettings.get());

    return (
      current?.oidc.enabled === true || (await this.deps.persistence.users.countActiveAdmins()) > 0
    );
  }

  async #claimSetupAdmin(
    admin: User,
  ): Promise<Result<{ readonly user: User; readonly adopted: boolean }, ConflictError>> {
    const { authSettings, users } = this.deps.persistence;
    const inserted = await users.insert(admin);
    if (inserted.isOk()) {
      return ok({ user: inserted.value, adopted: false });
    }
    const leftover = await users.findByUsername(admin.username);
    if (!leftover || (await authSettings.get()) !== undefined) {
      return err(inserted.error);
    }
    const replaced = await users.update(
      {
        ...admin,
        id: leftover.id,
        tokenVersion: leftover.tokenVersion + 1,
        version: leftover.version + 1,
        createdAt: leftover.createdAt,
      },
      leftover.version,
    );

    return replaced.isOk()
      ? ok({ user: replaced.value, adopted: true })
      : err({ code: 'conflict', message: replaced.error.message });
  }

  async #changeSettings(
    expectedVersion: number,
    change: (current: AuthSettings) => AuthSettings,
  ): Promise<Result<AuthSettings, SetupRequiredError | VersionConflictError>> {
    const current = await this.getSettings();
    if (current.isErr()) {
      return err(current.error);
    }
    const next: AuthSettings = {
      ...change(current.value),
      version: expectedVersion + 1,
      updatedAt: this.deps.clock.now(),
    };
    const saved = await this.deps.persistence.authSettings.update(next, expectedVersion);
    if (saved.isOk()) {
      this.deps.settings.set(saved.value);
    }

    return saved;
  }

  #placeholderHash(): Promise<string> {
    this.#dummyHash ??= this.deps.hasher.hash(generateSessionSecret());

    return this.#dummyHash;
  }
}
