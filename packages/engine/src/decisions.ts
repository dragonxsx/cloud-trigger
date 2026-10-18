import type { Clock, DecisionLog, Logger, ScheduleDecision } from '@cloud-trigger/core';

export type DecisionInput = Omit<ScheduleDecision, 'at' | 'runId'> &
  Partial<Pick<ScheduleDecision, 'at' | 'runId'>>;

export class DecisionRecorder {
  constructor(
    private readonly log: DecisionLog | undefined,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async record(decision: DecisionInput): Promise<void> {
    if (!this.log) {
      return;
    }
    await this.log
      .record({ runId: null, at: this.clock.now(), ...decision })
      .catch((error: unknown) =>
        this.logger.warn('Could not record a schedule decision', {
          jobId: decision.jobId,
          err: error,
        }),
      );
  }
}
