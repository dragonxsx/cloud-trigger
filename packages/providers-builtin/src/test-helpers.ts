import { type RunContext, mapSecretResolver } from '@cloud-trigger/core';

export const testContext = (overrides: Partial<RunContext> = {}): RunContext => ({
  runId: 'run-1',
  jobId: 'job-1',
  jobName: 'Test job',
  attempt: 1,
  scheduledAt: new Date('2026-01-01T00:00:00Z'),
  reason: 'manual',
  secrets: mapSecretResolver({ TOKEN: 's3cr3t' }),
  now: new Date('2026-01-01T00:00:05Z'),
  ...overrides,
});
