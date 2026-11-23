import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { ATTR_URL_FULL, ATTR_URL_PATH } from '@opentelemetry/semantic-conventions';
import { afterAll, describe, expect, it } from 'vitest';

import { webhookRedactingSpanProcessor } from '../src/infra/telemetry/webhook-redaction.js';

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({
  spanProcessors: [webhookRedactingSpanProcessor(), new SimpleSpanProcessor({ exporter })],
});
const tracer = provider.getTracer('test');

const exported = (name: string, attributes: Record<string, string>) => {
  tracer.startSpan(name, { attributes }).end();

  return exporter.getFinishedSpans().find((span) => span.name === name)?.attributes;
};

afterAll(async () => {
  await provider.shutdown();
});

describe('webhookRedactingSpanProcessor', () => {
  it('masks the token in url.path and url.full on any span', () => {
    const attributes = exported('HooksController.receive', {
      [ATTR_URL_PATH]: '/hooks/job-1/hook-secret-token',
      [ATTR_URL_FULL]: '/hooks/job-1/hook-secret-token?x=1',
    });

    expect(attributes).toMatchObject({
      [ATTR_URL_PATH]: '/hooks/job-1/***',
      [ATTR_URL_FULL]: '/hooks/job-1/***?x=1',
    });
    expect(JSON.stringify(attributes)).not.toContain('hook-secret-token');
  });

  it('leaves other urls untouched', () => {
    expect(
      exported('GET', { [ATTR_URL_PATH]: '/api/jobs', [ATTR_URL_FULL]: 'https://example.com/a' }),
    ).toMatchObject({ [ATTR_URL_PATH]: '/api/jobs', [ATTR_URL_FULL]: 'https://example.com/a' });
  });
});
