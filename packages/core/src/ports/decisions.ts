import type { ScheduleDecision } from '../domain/decision.js';
import type { JobId } from '../domain/ids.js';

export interface DecisionLog {
  record(decision: ScheduleDecision): Promise<void>;
  listRecent(
    jobId: JobId,
    p: { before: Date; limit: number },
  ): Promise<readonly ScheduleDecision[]>;
}
