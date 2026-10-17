export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly total: number;
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly offset?: number | undefined;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
