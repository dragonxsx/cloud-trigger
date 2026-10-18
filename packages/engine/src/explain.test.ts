import { JobSpec, createJob, newJobId } from '@cloud-trigger/core';
import { describe, expect, it } from 'vitest';

import { explain } from './explain.js';

const at = (iso: string) => new Date(iso);
const baseJob = createJob({
  id: newJobId(),
  spec: JobSpec.parse({
    name: 'ping',
    trigger: { type: 'interval', config: { every: 5, unit: 'minutes' } },
    target: { type: 'http', config: { url: 'http://x' } },
  }),
  nextFireAt: at('2026-03-01T10:05:00Z'),
  now: at('2026-03-01T10:00:00Z'),
});

describe('explain', () => {
  it('narrates an auto-paused job with its would-be next fire', () => {
    const job = {
      ...baseJob,
      pausedReason: 'Auto-paused after 5 consecutive failures',
      schedule: { ...baseJob.schedule, consecutiveFailures: 5 },
    };
    const result = explain({
      job,
      wouldFireAt: at('2026-03-01T10:05:00Z'),
      decisions: [
        {
          jobId: job.id,
          runId: null,
          at: at('2026-03-01T10:02:00Z'),
          fireTime: at('2026-03-01T10:00:00Z'),
          decision: 'paused',
          detail: job.pausedReason,
        },
      ],
    });
    expect(result.narrative[0]).toBe(
      'Paused since 2026-03-01 10:02 UTC: Auto-paused after 5 consecutive failures. Resume it to schedule runs again. Its next fire would be 2026-03-01 10:05 UTC.',
    );
    expect(result.narrative[1]).toBe('The last 5 run(s) failed in a row.');
  });

  it('explains an overlap skip on an otherwise healthy job', () => {
    const result = explain({
      job: baseJob,
      wouldFireAt: null,
      decisions: [
        {
          jobId: baseJob.id,
          runId: null,
          at: at('2026-03-01T10:00:01Z'),
          fireTime: at('2026-03-01T10:00:00Z'),
          decision: 'overlap_skipped',
          detail: 'overlap: forbid (previous run still active)',
        },
      ],
    });
    expect(result.narrative).toEqual([
      'Scheduled; the next run is due at 2026-03-01 10:05 UTC.',
      'At 2026-03-01 10:00 UTC the run scheduled for 2026-03-01 10:00 UTC was skipped because the previous run was still active (overlap: forbid (previous run still active)).',
    ]);
    expect(result.nextFireAt).toEqual(at('2026-03-01T10:05:00Z'));
  });
});
