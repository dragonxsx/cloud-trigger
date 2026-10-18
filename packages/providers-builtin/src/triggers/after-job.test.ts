import { describe, expect, it } from 'vitest';

import { afterJobTrigger } from './after-job.js';

const parentId = '01920000-0000-7000-8000-000000000001';
const event = (status: 'succeeded' | 'failed' | 'timed_out', jobId = parentId) => ({
  kind: 'run_finished' as const,
  jobId,
  runId: 'r',
  status,
});

describe('after_job trigger', () => {
  it('never schedules on its own and exposes its upstream edge', () => {
    const trigger = afterJobTrigger.bind({ jobId: parentId })._unsafeUnwrap();
    expect(
      trigger.nextFireAt({ after: new Date(), lastFiredAt: null, fireCount: 0, jobId: 'x' }),
    ).toBeNull();
    expect(trigger.upstream?.()).toEqual([{ jobId: parentId, path: 'jobId' }]);
  });

  it('matches the configured outcomes of the upstream job only', () => {
    const onSuccess = afterJobTrigger.bind({ jobId: parentId })._unsafeUnwrap();
    expect(onSuccess.matches?.(event('succeeded'))).toBe(true);
    expect(onSuccess.matches?.(event('failed'))).toBe(false);
    expect(onSuccess.matches?.(event('succeeded', '01920000-0000-7000-8000-000000000002'))).toBe(
      false,
    );
    const onFailure = afterJobTrigger.bind({ jobId: parentId, on: ['failed'] })._unsafeUnwrap();
    expect(onFailure.matches?.(event('timed_out'))).toBe(true);
    const onAny = afterJobTrigger.bind({ jobId: parentId, on: ['any'] })._unsafeUnwrap();
    expect(onAny.matches?.(event('failed'))).toBe(true);
  });

  it('rejects a malformed job id', () => {
    expect(afterJobTrigger.bind({ jobId: 'nope' }).isErr()).toBe(true);
  });
});
