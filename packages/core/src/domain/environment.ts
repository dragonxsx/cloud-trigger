import { z } from 'zod';

import { EnvironmentId } from './ids.js';
import { slug } from './slug.js';

export const EnvironmentKey = slug('Environment').describe(
  'Stable name of the environment; connection overlays and jobs reference it.',
);

export const EnvironmentSpec = z.object({
  key: EnvironmentKey,
  name: z.string().trim().max(200).default(''),
  description: z.string().max(2_000).default(''),
});
export type EnvironmentSpec = z.output<typeof EnvironmentSpec>;
export type EnvironmentSpecInput = z.input<typeof EnvironmentSpec>;

export const Environment = EnvironmentSpec.extend({
  id: EnvironmentId,
  version: z.int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Environment = z.output<typeof Environment>;

export const EnvironmentChoice = EnvironmentKey.nullable().default(null);

export function createEnvironment(params: {
  id: EnvironmentId;
  spec: EnvironmentSpec;
  now: Date;
}): Environment {
  return {
    ...params.spec,
    id: params.id,
    version: 1,
    createdAt: params.now,
    updatedAt: params.now,
  };
}
