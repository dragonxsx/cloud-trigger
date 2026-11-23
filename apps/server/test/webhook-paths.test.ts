import { describe, expect, it } from 'vitest';

import { redactWebhookToken, webhookTokenForms } from '../src/common/webhook-paths.js';

describe('webhook paths', () => {
  it('finds the token in raw and decoded form', () => {
    expect(webhookTokenForms('/hooks/job-1/a%2Bb')).toEqual(['a%2Bb', 'a+b']);
    expect(webhookTokenForms('/hooks/job-1/plain')).toEqual(['plain']);
    expect(webhookTokenForms('/hooks/job-1')).toEqual([]);
    expect(webhookTokenForms('/hooks//no-job-id')).toEqual(['no-job-id']);
    expect(webhookTokenForms('/api/hooks/job-1/x')).toEqual([]);
  });

  it('masks the token and keeps the rest of the url', () => {
    expect(redactWebhookToken('/hooks/job-1/secret?sig=1')).toBe('/hooks/job-1/***?sig=1');
    expect(redactWebhookToken('/api/jobs')).toBe('/api/jobs');
  });
});
