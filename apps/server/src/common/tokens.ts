import type { FactoryProvider, INestApplicationContext, InjectionToken } from '@nestjs/common';

export interface Token<T> {
  readonly key: symbol;
  readonly type?: T;
}

export const token = <T>(name: string): Token<T> => ({ key: Symbol(name) });

type ClassOf<T> = abstract new (...args: never) => T;

export type Dependency = Token<unknown> | ClassOf<unknown>;

type Resolve<D> = D extends Token<infer V> ? V : D extends ClassOf<infer I> ? I : never;

export type Resolved<D extends readonly Dependency[]> = { [K in keyof D]: Resolve<D[K]> };

export const injectionToken = (dependency: Dependency): InjectionToken =>
  typeof dependency === 'function' ? dependency : dependency.key;

export const factory = <const D extends readonly Dependency[], R>(
  inject: D,
  useFactory: (...deps: Resolved<D>) => R,
) => ({ inject: inject.map(injectionToken), useFactory });

export const factoryProvider = <T, const D extends readonly Dependency[]>(
  provide: Token<T> | ClassOf<T>,
  inject: D,
  useFactory: (...deps: Resolved<D>) => T | Promise<T>,
): FactoryProvider<T> => ({ provide: injectionToken(provide), ...factory(inject, useFactory) });

export const valueProvider = <T>(provide: Token<T> | ClassOf<T>, value: T): FactoryProvider<T> =>
  factoryProvider(provide, [], () => value);

export const resolveToken = <T>(app: INestApplicationContext, dependency: Token<T>): T =>
  app.get<T>(dependency.key);
