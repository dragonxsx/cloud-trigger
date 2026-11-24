import 'reflect-metadata';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveToken } from '../src/common/tokens.js';
import { TELEMETRY } from '../src/infra/telemetry/telemetry.module.js';
import { respondOk, type TestServer, startTestServer } from './support/app.js';
import { waitFor } from './support/client.js';
import { tempSqlite } from './support/databases.js';

const sqlite = tempSqlite('metrics');
let server: TestServer;
let target: TestHttpServer;

const scrape = async (): Promise<string> => {
  const response = await fetch(`${server.baseUrl}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('version=0.0.4');

  return response.text();
};

const lagCount = (text: string) =>
  Number(/cloud_trigger_run_start_lag_seconds_count\{target_type="http"\} (\d+)/.exec(text)?.[1]);

const succeeded = (text: string) =>
  Number(/cloud_trigger_runs_total\{status="succeeded",target_type="http"\} (\d+)/.exec(text)?.[1]);

beforeAll(async () => {
  target = await startTestHttpServer(respondOk);
  server = await startTestServer({ ...sqlite.env, WORKER_POLL_MS: '50' });
});

afterAll(async () => {
  await server.close();
  await target.close();
  sqlite.cleanup();
});

describe('/metrics', () => {
  it('serves run and engine metrics in Prometheus text format', async () => {
    const api = server.client();
    const job = await api.jobs.create({
      name: 'measured',
      trigger: { type: 'manual', config: {} },
      target: { type: 'http', config: { method: 'GET', url: target.url } },
    });
    await api.jobs.run({ id: job.id });

    const body = await waitFor(async () => {
      const text = await scrape();

      return text.includes('cloud_trigger_runs_total{') ? text : undefined;
    });
    expect(body).toContain('cloud_trigger_runs_total{status="succeeded",target_type="http"} 1');
    expect(body).toContain('# TYPE cloud_trigger_run_duration_seconds histogram');
    expect(body).toContain('cloud_trigger_run_duration_seconds_bucket{');
    expect(body).toContain('cloud_trigger_run_start_lag_seconds_count{target_type="http"} 1');
    expect(body).toContain('cloud_trigger_worker_active_runs');
    expect(body).not.toContain('otel_scope_name');
    expect(body).toContain('nodejs_eventloop');
  });

  it('leaves backfilled runs out of the start lag', async () => {
    const api = server.client();
    const job = await api.jobs.create({
      name: 'backfilled',
      trigger: { type: 'cron', config: { expression: '0 * * * *' } },
      target: { type: 'http', config: { method: 'GET', url: target.url } },
    });
    const before = await scrape();

    const { created } = await api.jobs.backfill({
      id: job.id,
      from: '2026-02-01T00:00:00Z',
      to: '2026-02-01T02:30:00Z',
    });
    const after = await waitFor(async () => {
      const text = await scrape();

      return succeeded(text) >= succeeded(before) + created.length ? text : undefined;
    });

    expect(created).toHaveLength(3);
    expect(lagCount(after)).toBe(lagCount(before));
  });

  it('answers 503 when collection fails, so Prometheus marks the target down', async () => {
    resolveToken(server.app, TELEMETRY)
      .meterProvider.getMeter('test')
      .createObservableGauge('broken_gauge')
      .addCallback(() => {
        throw new Error('gauge exploded');
      });

    const response = await fetch(`${server.baseUrl}/metrics`);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('gauge exploded');
  });
});
