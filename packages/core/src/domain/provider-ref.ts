import { z } from 'zod';

export const ProviderRef = z.object({
  type: z.string().min(1),
  config: z.unknown(),
});
export type ProviderRef = z.output<typeof ProviderRef>;
