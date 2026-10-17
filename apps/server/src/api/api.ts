import { type Contract, contract } from '@cloud-trigger/api-contract';
import { type ConfigError, type DomainError, assertNever } from '@cloud-trigger/core';
import type { InferContractRouterErrorMap } from '@orpc/contract';
import { implement } from '@orpc/nest';
import type { ORPCErrorConstructorMap } from '@orpc/server';

import type { AppContext } from '../app-context.js';
import { type Principal, hasScope } from '../auth/authenticator.js';

export interface ApiInitialContext {
  readonly reqHeaders?: Headers;
}

export const createApi = (ctx: AppContext) =>
  implement(contract)
    .$context<ApiInitialContext>()
    .use(async ({ context, next, procedure, errors }) => {
      const result = await ctx.authenticator.authenticate(context.reqHeaders);
      if (result === 'missing') {
        throw errors.UNAUTHORIZED({ message: 'Authentication required' });
      }
      if (result === 'invalid') {
        throw errors.UNAUTHORIZED({ message: 'Invalid credentials' });
      }
      const principal: Principal = result;
      const required = procedure['~orpc'].meta.minimumScope;
      if (!hasScope(principal, required)) {
        throw errors.FORBIDDEN({ message: `Requires "${required}" scope` });
      }

      return next({ context: { principal } });
    });

export type Api = ReturnType<typeof createApi>;

type KnownError =
  | ConfigError
  | DomainError<
      'not_found' | 'version_conflict' | 'duplicate_run' | 'not_finished' | 'not_cancellable'
    >;

export type ErrorFactories = Pick<
  ORPCErrorConstructorMap<InferContractRouterErrorMap<Contract>>,
  'NOT_FOUND' | 'CONFLICT' | 'INVALID_CONFIG'
>;

export function toApiError(errors: ErrorFactories, error: KnownError): Error {
  switch (error.code) {
    case 'not_found':
      return errors.NOT_FOUND({ message: error.message });
    case 'invalid_config':
      return errors.INVALID_CONFIG({ message: error.message, data: { issues: [...error.issues] } });
    case 'version_conflict':
    case 'duplicate_run':
    case 'not_finished':
    case 'not_cancellable':
      return errors.CONFLICT({ message: error.message });
    default:
      return assertNever(error);
  }
}
