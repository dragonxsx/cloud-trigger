import 'reflect-metadata';
import { type TestHttpServer, startTestHttpServer } from '@cloud-trigger/testing';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TransportBridge } from '../src/mcp/transport-bridge.js';
import { API_KEYS, respondOk, type TestServer, startTestServer } from './support/app.js';
import { errorCode, rejection, waitFor } from './support/client.js';
import { mongoEnv } from './support/databases.js';

let server: TestServer;
let target: TestHttpServer;

beforeAll(async () => {
  target = await startTestHttpServer(respondOk);
  server = await startTestServer(mongoEnv('integrations'), { auth: API_KEYS });
});

afterAll(async () => {
  await server.close();
  await target.close();
});

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${server.baseUrl}${path}`, { method: 'POST', body, headers });

describe('inbound webhooks', () => {
  it('turns a POST into an event run whose payload is the request body', async () => {
    const api = server.client('w-key');
    const job = await api.jobs.create({
      name: 'on webhook',
      trigger: {
        type: 'webhook',
        config: { token: 'a-long-enough-token', rateLimit: { perSecond: 1 } },
      },
      input: { type: 'event', config: {} },
      target: { type: 'http', config: { method: 'POST', url: `${target.url}/from-hook` } },
    });
    const redacted = await api.jobs.get({ id: job.id });
    expect(redacted.trigger.config).toMatchObject({ token: '***' });

    const accepted = await post(`/hooks/${job.id}/a-long-enough-token`, '{"x":1}', {
      'content-type': 'application/json',
      'idempotency-key': 'delivery-1',
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ duplicate: false });

    const limited = await post(`/hooks/${job.id}/a-long-enough-token`, '{"x":2}');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');

    const delivery = await waitFor(() => target.requests.find((r) => r.url === '/from-hook'));
    expect(delivery.body).toBe('{"x":1}');
    const runs = await api.runs.list({ jobId: job.id });
    expect(runs.items[0]).toMatchObject({ reason: 'event' });
  });

  it('answers 404 for wrong tokens and unknown jobs, and 413 for large bodies', async () => {
    const api = server.client('w-key');
    const job = await api.jobs.create({
      name: 'guarded webhook',
      trigger: { type: 'webhook', config: { token: 'another-long-token' } },
      target: { type: 'http', config: { method: 'POST', url: `${target.url}/guarded` } },
    });
    expect((await post(`/hooks/${job.id}/wrong-token-0000000`, '{}')).status).toBe(404);
    expect((await post('/hooks/not-a-uuid/another-long-token', '{}')).status).toBe(404);
    expect((await post(`/hooks/${job.id}/another-long-token`, 'x'.repeat(300 * 1024))).status).toBe(
      413,
    );
  });
});

describe('fan-out', () => {
  it('redacts nested secrets, keeps them on update, and records a result per child', async () => {
    const api = server.client('w-key');
    const spec = {
      name: 'fan-out',
      trigger: { type: 'cron', config: { expression: '0 0 1 1 *' } },
      target: {
        type: 'fanout',
        config: {
          targets: [
            {
              type: 'http',
              name: 'Primary',
              config: {
                url: `${target.url}/fan-a`,
                secretHeaders: { authorization: 'Bearer s3cret' },
              },
            },
            { type: 'http', config: { url: `${target.url}/fan-b` } },
          ],
        },
      },
    };
    const job = await api.jobs.create(spec);
    const fetched = await api.jobs.get({ id: job.id });
    expect(fetched.target.config).toMatchObject({
      targets: [{ config: { secretHeaders: { authorization: '***' } } }, { config: {} }],
    });
    await api.jobs.update({
      ...spec,
      id: job.id,
      name: 'fan-out 2',
      target: fetched.target,
      expectedVersion: fetched.version,
    });

    await api.jobs.run({ id: job.id });
    await waitFor(() => target.requests.find((r) => r.url === '/fan-b'));
    const run = await waitFor(async () => {
      const [latest] = (await api.runs.list({ jobId: job.id })).items;

      return latest?.status === 'succeeded' ? latest : undefined;
    });
    expect(run.result?.metadata).toMatchObject({
      mode: 'all',
      children: [
        { name: 'Primary', outcome: 'success' },
        { type: 'http', outcome: 'success' },
      ],
    });
    const stored = await server.persistence.jobs.get(job.id);
    expect(stored?.target.config).toMatchObject({
      targets: [
        { config: { secretHeaders: { authorization: 'Bearer s3cret' } } },
        { type: 'http' },
      ],
    });
  });
});

describe('workflows', () => {
  it('runs a DAG with an approval gate approved through the API', async () => {
    const api = server.client('w-key');
    const spec = {
      name: 'release train',
      nodes: [
        {
          key: 'build',
          kind: 'inline' as const,
          job: {
            target: {
              type: 'http',
              config: {
                url: `${target.url}/wf-build`,
                secretHeaders: { authorization: 'Bearer s3cret' },
              },
            },
          },
        },
        { key: 'approve', kind: 'approval' as const },
        {
          key: 'deploy',
          kind: 'inline' as const,
          job: { target: { type: 'http', config: { url: `${target.url}/wf-deploy` } } },
        },
      ],
      edges: [
        { from: 'build', to: 'approve' },
        { from: 'approve', to: 'deploy' },
      ],
    };
    const workflow = await api.workflows.create(spec);
    expect(workflow.nodes[0]).toMatchObject({
      job: { target: { config: { secretHeaders: { authorization: '***' } } } },
    });
    const renamed = await api.workflows.update({
      ...spec,
      nodes: workflow.nodes,
      id: workflow.id,
      name: 'release train 2',
      expectedVersion: workflow.version,
    });
    expect(renamed.version).toBe(2);
    const buildJob = renamed.inlineJobIds['build'];
    const owned = buildJob ? await server.persistence.jobs.get(buildJob) : undefined;
    expect(owned?.target.config).toMatchObject({
      secretHeaders: { authorization: 'Bearer s3cret' },
    });

    const reader = server.client('r-key');
    expect(await errorCode(reader.workflows.run({ id: workflow.id }))).toBe('FORBIDDEN');
    const run = await api.workflows.run({ id: workflow.id });
    const waiting = await waitFor(async () => {
      const current = await api.workflowRuns.get({ id: run.id });

      return current.nodes['approve']?.status === 'waiting_approval' ? current : undefined;
    });
    expect(waiting.nodes['build']?.status).toBe('succeeded');

    const approved = await api.workflowRuns.approve({ id: run.id, node: 'approve' });
    expect(approved.nodes['approve']).toMatchObject({
      status: 'succeeded',
      decidedBy: 'api-key:writer',
    });
    expect(await errorCode(api.workflowRuns.approve({ id: run.id, node: 'approve' }))).toBe(
      'CONFLICT',
    );
    const finished = await waitFor(async () => {
      const current = await api.workflowRuns.get({ id: run.id });

      return current.status === 'running' ? undefined : current;
    });
    expect(finished.status).toBe('succeeded');
    expect(target.requests.some((r) => r.url === '/wf-deploy')).toBe(true);

    const listed = await api.workflowRuns.list({ workflowId: workflow.id });
    expect(listed.items.map((r) => r.id)).toEqual([run.id]);
    const deployJob = renamed.inlineJobIds['deploy'];
    if (!deployJob) {
      throw new Error('deploy job missing');
    }
    expect(await errorCode(api.jobs.delete({ id: deployJob }))).toBe('CONFLICT');
    expect(await api.workflows.delete({ id: workflow.id })).toEqual({ deleted: true });
  });

  it('rejects cyclic graphs with field issues', async () => {
    const api = server.client('w-key');
    expect(
      await rejection(
        api.workflows.create({
          name: 'cycle',
          nodes: [
            { key: 'a', kind: 'approval' },
            { key: 'b', kind: 'approval' },
          ],
          edges: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
        }),
      ),
    ).toMatchObject({ code: 'INVALID_CONFIG', data: { issues: [{ path: 'edges' }] } });
  });
});

const connect = async (apiKey?: string) => {
  const mcp = new McpClient({ name: 'e2e', version: '1.0.0' });
  await mcp.connect(
    new TransportBridge(
      new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
        requestInit: { headers: apiKey ? { 'x-api-key': apiKey } : {} },
      }),
    ),
  );

  return mcp;
};
const textOf = (result: Awaited<ReturnType<McpClient['callTool']>>) => {
  const parsed = z
    .object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
    .parse(result);

  return parsed.content.map((part) => part.text).join('');
};

describe('MCP server', () => {
  it('offers tools by scope', async () => {
    const reader = await connect('r-key');
    const readerTools = (await reader.listTools()).tools.map((tool) => tool.name);
    expect(readerTools).toEqual(expect.arrayContaining(['list_jobs', 'get_run', 'explain_job']));
    expect(readerTools).not.toContain('create_job');
    await expect(
      reader.callTool({
        name: 'pause_job',
        arguments: { id: '0190a000-0000-7000-8000-000000000009' },
      }),
    ).rejects.toThrow(/pause_job not found/);
    await reader.close();

    const writer = await connect('w-key');
    const tools = (await writer.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['create_job', 'run_job', 'pause_job', 'approve_workflow_run']),
    );
    const createJob = tools.find((tool) => tool.name === 'create_job');
    expect(createJob?.inputSchema.properties).toHaveProperty('target');
    await writer.close();
  });

  it('runs jobs through the API in-process', async () => {
    const writer = await connect('w-key');

    const created = await writer.callTool({
      name: 'create_job',
      arguments: {
        name: 'from mcp',
        trigger: { type: 'manual', config: {} },
        target: {
          type: 'http',
          config: { url: `${target.url}/from-mcp`, secretHeaders: { authorization: 'Bearer zzz' } },
        },
      },
    });
    const job = z
      .object({ id: z.string(), target: z.object({ config: z.record(z.string(), z.unknown()) }) })
      .parse(JSON.parse(textOf(created)));
    expect(job.target.config['secretHeaders']).toEqual({ authorization: '***' });

    const queued = await writer.callTool({ name: 'run_job', arguments: { id: job.id } });
    const run = z.object({ id: z.string() }).parse(JSON.parse(textOf(queued)));
    await waitFor(() => target.requests.find((r) => r.url === '/from-mcp'));
    const fetched = await writer.callTool({ name: 'get_run', arguments: { id: run.id } });
    expect(textOf(fetched)).toContain(job.id);

    const resource = await writer.readResource({ uri: `job://${job.id}` });
    expect(JSON.stringify(resource.contents)).toContain('from mcp');

    const summary = await writer.callTool({
      name: 'analytics_summary',
      arguments: {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(JSON.parse(textOf(summary))).toHaveProperty('total');

    const explained = await writer.callTool({
      name: 'explain_job',
      arguments: { id: job.id, at: new Date().toISOString() },
    });
    expect(explained.isError).toBeFalsy();

    const missing = await writer.callTool({
      name: 'get_job',
      arguments: { id: '0190a000-0000-7000-8000-000000000009' },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/^NOT_FOUND/);
    await writer.close();
  });

  it('rejects unauthenticated clients', async () => {
    await expect(connect()).rejects.toThrow(/Authentication required|401/);
  });
});
