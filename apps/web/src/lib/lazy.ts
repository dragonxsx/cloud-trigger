import { type ComponentType, type LazyExoticComponent, lazy } from 'react';

export const lazyNamed = <K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
): LazyExoticComponent<ComponentType> => lazy(async () => ({ default: (await load())[name] }));
