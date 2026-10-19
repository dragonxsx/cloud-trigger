import type { Persistence } from '@cloud-trigger/core';

export interface TestPersistence<P extends Persistence = Persistence> {
  readonly persistence: P;
  /** Empties the named collections or tables; every one when omitted. */
  readonly clear: (tables?: readonly string[]) => Promise<void>;
  readonly stop: () => Promise<void>;
}
