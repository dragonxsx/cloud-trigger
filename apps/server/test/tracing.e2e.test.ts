import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { type IncomingHttpHeaders, Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Contract, contract } from '@cloud-trigger/api-contract';
import type { INestApplication } from '@nestjs/common';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import { OtelRunTracer } from '../src/infra/telemetry/tracing.js';
import { createTestApp } from './support/app.js';

type Client = JsonifiedClient<ContractRouterClient<Contract>>;

const dir = mkdtempSync(join(tmpdir(), 'ct-tracing-'));
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const received: IncomingHttpHeaders[] = [];
let app: INestApplication;
let target: Server;
let targetUrl = '';
let baseUrl = '';

interface Listenable {
  listen(port: number, host: string, cb: () => void): unknown;
  address(): ReturnType<Server['address']>;
}

const listen = async (server: Listenable): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('tcp');
  }

  return `http://127.0.0.1:${address.port}`;
};

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

beforeAll(async () => {
  target = createServer((req, res) => {
    received.push(req.headers);
    res.end('{"ok":true}');
  });
  targetUrl = await listen(target);
  const config = loadConfig({
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: join(dir, 'app.db'),
    AUTH_DISABLED: 'true',
    WORKER_POLL_MS: '50',
  });
  ({ app } = await createTestApp(config, {
    tracer: new OtelRunTracer(provider.getTracer('test')),
  }));
  await app.init();
  const http: unknown = app.getHttpServer();
  if (!(http instanceof Server)) {
    throw new Error('Expected a node:http server');
  }
  baseUrl = await listen(http);
}, 60_000);

afterAll(async () => {
  await app.close();
  await provider.shutdown();
  await new Promise<void>((resolve) => target.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('OpenTelemetry', () => {
  it('records a span per run attempt and propagates traceparent to the target', async () => {
    const api: Client = createORPCClient(new OpenAPILink(contract, { url: baseUrl }));
    const job = await api.jobs.create({
      name: 'traced',
      trigger: { type: 'manual', config: {} },
      target: { type: 'http', config: { method: 'GET', url: targetUrl } },
    });
    const run = await api.jobs.run({ id: job.id });
    await waitFor(() => exporter.getFinishedSpans().length > 0);

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes).toMatchObject({ 'job.id': job.id, 'run.id': run.id, attempt: 1 });
    const traceparent = received.at(-1)?.['traceparent'];
    expect(traceparent).toBe(`00-${span?.spanContext().traceId}-${span?.spanContext().spanId}-01`);
  });

  it('continues the trace of an inbound webhook', async () => {
    exporter.reset();
    const api: Client = createORPCClient(new OpenAPILink(contract, { url: baseUrl }));
    const job = await api.jobs.create({
      name: 'traced hook',
      trigger: { type: 'webhook', config: { token: 'a-long-enough-token' } },
      target: { type: 'http', config: { method: 'GET', url: targetUrl } },
    });
    const inbound = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const accepted = await fetch(`${baseUrl}/hooks/${job.id}/a-long-enough-token`, {
      method: 'POST',
      headers: { traceparent: inbound },
      body: '{}',
    });
    expect(accepted.status).toBe(202);
    await waitFor(() => exporter.getFinishedSpans().length > 0);
    const [span] = exporter.getFinishedSpans();
    expect(span?.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span?.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
  });
});
