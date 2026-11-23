import {
  type Clock,
  type DecisionLog,
  type EngineMetrics,
  type Logger,
  type ScheduleDecision,
  noopEngineMetrics,
} from '@cloud-trigger/core';

export type DecisionInput = Omit<ScheduleDecision, 'at' | 'runId'> &
  Partial<Pick<ScheduleDecision, 'at' | 'runId'>>;

export class DecisionRecorder {
  constructor(
    private readonly log: DecisionLog | undefined,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics: EngineMetrics = noopEngineMetrics,
  ) {}

  async record(decision: DecisionInput): Promise<void> {
    this.metrics.record({ kind: 'decision', decision: decision.decision });
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
