import 'reflect-metadata';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OtelRunTracer } from '../src/infra/telemetry/tracing.js';
import { respondOk, type TestServer, startTestServer } from './support/app.js';
import { waitFor } from './support/client.js';
import { tempSqlite } from './support/databases.js';

const sqlite = tempSqlite('tracing');
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
let server: TestServer;
let target: TestHttpServer;

const finishedSpan = () => waitFor(() => exporter.getFinishedSpans()[0]);

beforeAll(async () => {
  target = await startTestHttpServer(respondOk);
  server = await startTestServer(
    { ...sqlite.env, WORKER_POLL_MS: '50' },
    { tracer: new OtelRunTracer(provider.getTracer('test')) },
  );
});

afterAll(async () => {
  await server.close();
  await provider.shutdown();
  await target.close();
  sqlite.cleanup();
});

describe('OpenTelemetry', () => {
  it('records a span per run attempt and propagates traceparent to the target', async () => {
    const api = server.client();
    const job = await api.jobs.create({
      name: 'traced',
      trigger: { type: 'manual', config: {} },
      target: { type: 'http', config: { method: 'GET', url: target.url } },
    });
    const run = await api.jobs.run({ id: job.id });

    const span = await finishedSpan();
    expect(span.attributes).toMatchObject({ 'job.id': job.id, 'run.id': run.id, attempt: 1 });
    const traceparent = target.requests.at(-1)?.headers['traceparent'];
    expect(traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
  });

  it('continues the trace of an inbound webhook', async () => {
    exporter.reset();
    const api = server.client();
    const job = await api.jobs.create({
      name: 'traced hook',
      trigger: { type: 'webhook', config: { token: 'a-long-enough-token' } },
      target: { type: 'http', config: { method: 'GET', url: target.url } },
    });
    const inbound = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const accepted = await fetch(`${server.baseUrl}/hooks/${job.id}/a-long-enough-token`, {
      method: 'POST',
      headers: { traceparent: inbound },
      body: '{}',
    });
    expect(accepted.status).toBe(202);
    const span = await finishedSpan();
    expect(span.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
  });
});
