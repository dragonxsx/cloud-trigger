import type { DecisionKind } from '../domain/decision.js';
import type { RunReason } from '../domain/run.js';

export type EngineSignal =
  | { readonly kind: 'fired'; readonly reason: RunReason; readonly count: number }
  | { readonly kind: 'fire_dropped' }
  | { readonly kind: 'decision'; readonly decision: DecisionKind }
  | {
      readonly kind: 'attempt_started';
      readonly reason: RunReason;
      readonly targetType: string;
      readonly attempt: number;
      readonly lagMs: number;
    }
  | { readonly kind: 'lease_expired' }
  | { readonly kind: 'stale_commit' };

export interface EngineMetrics {
  readonly record: (signal: EngineSignal) => void;
}

export const noopEngineMetrics: EngineMetrics = { record: () => undefined };
