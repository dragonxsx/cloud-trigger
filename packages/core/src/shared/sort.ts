import { z } from 'zod';

export const SortOrder = z.enum(['asc', 'desc']);
export type SortOrder = z.output<typeof SortOrder>;
