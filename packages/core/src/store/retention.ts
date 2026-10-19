export interface RetentionPolicy {
  readonly runDays: number;
  readonly metricsDays: number;
  readonly decisionDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  runDays: 30,
  metricsDays: 90,
  decisionDays: 14,
};
