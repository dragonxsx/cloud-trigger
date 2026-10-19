import { describe, expect, it } from 'vitest';

import { CONTRACT_TOOLS } from '../src/mcp/contract-tools.js';

const named = (name: string) => CONTRACT_TOOLS.find((entry) => entry.tool.name === name);

describe('contract tools', () => {
  it('derives every MCP tool from the contract meta', () => {
    expect(CONTRACT_TOOLS.map((entry) => entry.tool.name).toSorted()).toEqual([
      'analytics_summary',
      'approve_workflow_run',
      'create_job',
      'explain_job',
      'get_job',
      'get_run',
      'list_connections',
      'list_jobs',
      'list_runs',
      'list_workflows',
      'pause_job',
      'resume_job',
      'run_job',
    ]);
    expect(named('list_jobs')).toMatchObject({ path: ['jobs', 'list'], scope: 'read' });
    expect(named('list_connections')).toMatchObject({
      path: ['connections', 'list'],
      scope: 'read',
    });
    expect(named('approve_workflow_run')).toMatchObject({
      path: ['workflowRuns', 'approve'],
      scope: 'write',
    });
  });

  it('describes inputs as the wire format the API accepts', () => {
    expect(named('list_runs')?.tool.inputSchema.properties?.['from']).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
    expect(named('run_job')?.tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['id'],
      properties: { idempotencyKey: { type: 'string' } },
    });
  });

  it('marks read tools read-only and write tools not', () => {
    expect(named('get_job')?.tool.annotations).toEqual({ readOnlyHint: true });
    expect(named('pause_job')?.tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });
});
