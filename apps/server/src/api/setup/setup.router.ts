import type { DatabaseSettings, SetupStage } from '@cloud-trigger/api-contract';
import {
  type AuthMethods,
  type ConfigError,
  type ConfigIssue,
  type ConflictError,
  type Result,
  assertNever,
} from '@cloud-trigger/core';
import type { z } from 'zod';

import {
  type Authenticate,
  fetchJwksUri,
  hasScope,
  isAuthFailure,
} from '../../auth/authenticator.js';
import type { IssuedSession } from '../../auth/sessions.js';
import type { SetupToken } from '../../auth/setup-token.js';
import type { DatabaseConfig, DatabaseDriver } from '../../config/config.js';
import { probeDatabase } from '../../infra/persistence/persistence.js';
import { type Api, toApiError } from '../shared/api.js';

export interface SetupBackend {
  readonly stage: () => Promise<z.output<typeof SetupStage>>;
  readonly database: {
    readonly driver: DatabaseDriver | null;
    readonly issues: readonly ConfigIssue[];
  };
  readonly complete: (p: {
    readonly admin: { readonly username: string; readonly password: string };
    readonly methods: AuthMethods;
  }) => Promise<Result<IssuedSession, ConflictError | ConfigError>>;
}

export interface SetupRouterDeps {
  readonly api: Api;
  readonly backend: SetupBackend;
  readonly token: SetupToken;
  readonly authenticator: Authenticate;
}

type DatabaseInput = z.output<typeof DatabaseSettings>;

const toDatabase = (
  input: DatabaseInput,
): { config: DatabaseConfig; env: Record<string, string> } => {
  switch (input.driver) {
    case 'mongo':
      return {
        config: {
          driver: 'mongo',
          uri: input.uri,
          dbName: input.database,
          analyticsUri: undefined,
          analyticsDbName: undefined,
        },
        env: { DB_DRIVER: 'mongo', MONGO_URI: input.uri, MONGO_DB: input.database },
      };
    case 'postgres':
      return {
        config: { driver: 'postgres', url: input.url, maxConnections: 1 },
        env: { DB_DRIVER: 'postgres', POSTGRES_URL: input.url },
      };
    case 'sqlite':
      return {
        config: { driver: 'sqlite', path: input.path },
        env: { DB_DRIVER: 'sqlite', SQLITE_PATH: input.path },
      };
    default:
      return assertNever(input);
  }
};

export const setupHandlers = ({ api, backend, token, authenticator }: SetupRouterDeps) => {
  const setup = api.setup;
  const pending = async () => (await backend.stage()) !== 'done';

  return {
    status: setup.status.handler(async () => ({
      stage: await backend.stage(),
      database: { driver: backend.database.driver, issues: [...backend.database.issues] },
    })),

    verifyToken: setup.verifyToken.handler(async ({ input, errors }) => {
      if (!(await pending())) {
        throw errors.CONFLICT({ message: 'Setup has already been completed' });
      }
      if (!token.matches(input.token)) {
        throw errors.UNAUTHORIZED({ message: 'That setup token is not valid' });
      }

      return { ok: true as const };
    }),

    testDatabase: setup.testDatabase.handler(async ({ input, errors }) => {
      if (!(await pending())) {
        throw errors.CONFLICT({ message: 'Setup has already been completed' });
      }
      if (!token.matches(input.token)) {
        throw errors.UNAUTHORIZED({ message: 'That setup token is not valid' });
      }
      const { config, env } = toDatabase(input.database);
      const error = await probeDatabase(config);

      return { ok: error === undefined, error: error ?? null, env };
    }),

    testOidc: setup.testOidc.handler(async ({ input, context, errors }) => {
      const viaToken = (await pending()) && token.matches(input.token);
      if (!viaToken) {
        const principal = await authenticator.authenticate(context.reqHeaders);
        if (isAuthFailure(principal) || !hasScope(principal, 'admin')) {
          throw errors.UNAUTHORIZED({ message: 'Requires the setup token or the admin scope' });
        }
      }
      try {
        return { ok: true, error: null, jwksUri: await fetchJwksUri(input.issuer) };
      } catch (error: unknown) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          jwksUri: null,
        };
      }
    }),

    complete: setup.complete.handler(async ({ input, errors }) => {
      if (!token.matches(input.token)) {
        throw errors.UNAUTHORIZED({ message: 'That setup token is not valid' });
      }
      const session = await backend.complete({ admin: input.admin, methods: input.methods });
      if (session.isErr()) {
        throw toApiError(errors, session.error);
      }

      return session.value;
    }),
  };
};

export class SetupRouter {
  constructor(readonly handlers: ReturnType<typeof setupHandlers>) {}
}
