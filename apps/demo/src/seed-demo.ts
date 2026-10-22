import type { ApiClient } from './api-client.js';

type JobInput = Parameters<ApiClient['jobs']['create']>[0];
type GroupInput = Parameters<ApiClient['groups']['create']>[0];
type ConnectionInput = Parameters<ApiClient['connections']['create']>[0];
type WorkflowInput = Parameters<ApiClient['workflows']['create']>[0];
type InlineStep = Extract<WorkflowInput['nodes'][number], { kind: 'inline' }>['job'];

export interface SeedDemoOptions {
  readonly targetUrl: string;
  readonly serverUrl: string;
  readonly now: Date;
}

export interface SeedDemoReport {
  readonly created: readonly string[];
  readonly existing: readonly string[];
}

const DAY_MS = 86_400_000;
const STOREFRONT = 'storefront';
const WEBHOOK_TOKEN = 'demo-orders-webhook-token';

const echoHeaders = (delayMs: number, status?: number): Record<string, string> => ({
  'x-set-response-delay-ms': String(delayMs),
  ...(status === undefined ? {} : { 'x-set-response-status-code': String(status) }),
});

const storefront = (targetUrl: string): ConnectionInput => ({
  key: STOREFRONT,
  name: 'Storefront API',
  description: 'Demo HTTP API served by the echo container.',
  type: 'http',
  config: { baseUrl: `${targetUrl}/v1`, headers: { 'x-client': 'cloud-trigger-demo' } },
  endpoints: [
    {
      key: 'charge',
      name: 'Charge subscriptions',
      target: { type: 'http', config: { method: 'POST', url: '/charges' } },
    },
    {
      key: 'inventory',
      name: 'Sync inventory',
      target: { type: 'http', config: { method: 'POST', url: '/inventory/sync' } },
    },
    {
      key: 'reports',
      name: 'Daily report',
      target: { type: 'http', config: { method: 'GET', url: '/reports/{day}' } },
    },
  ],
});

const groups: readonly GroupInput[] = [
  {
    name: 'Payments',
    color: '#2a5bd7',
    description: 'Billing jobs share retries and a concurrency cap.',
    defaultPolicy: { retry: { maxAttempts: 3, backoff: 'exponential', delayMs: 1_000 } },
    rateLimit: { maxConcurrent: 4 },
  },
  {
    name: 'Operations',
    color: '#0ca678',
    description: 'Housekeeping and reporting.',
  },
];

const every = (seconds: number) => ({
  type: 'interval',
  config: { every: seconds, unit: 'seconds' },
});

const viaStorefront = (endpoint: string, config: Record<string, unknown>) => ({
  type: 'http',
  connection: { key: STOREFRONT, endpoint },
  config,
});

const jobs = (groupIds: ReadonlyMap<string, string>): readonly JobInput[] => {
  const payments = groupIds.get('Payments') ?? null;
  const operations = groupIds.get('Operations') ?? null;

  return [
    {
      name: 'Charge subscriptions',
      description: 'Bills every due subscription.',
      tags: ['billing'],
      groupId: payments,
      trigger: every(20),
      input: { type: 'static', config: { format: 'json', value: { batch: 'due-today' } } },
      target: viaStorefront('charge', { headers: echoHeaders(120) }),
    },
    {
      name: 'Sync inventory',
      description: 'Pushes stock levels to the storefront.',
      tags: ['catalog'],
      groupId: operations,
      trigger: { type: 'cron', config: { expression: '* * * * *', timezone: 'America/New_York' } },
      target: viaStorefront('inventory', { headers: echoHeaders(420) }),
    },
    {
      name: 'Warm search cache',
      tags: ['catalog'],
      groupId: operations,
      trigger: every(30),
      target: {
        type: 'http',
        config: { method: 'GET', url: '/v1/cache/warm' },
        connection: { key: STOREFRONT },
      },
    },
    {
      name: 'Reconcile ledger',
      description: 'Fails its JSONPath assertion until the ledger balances.',
      tags: ['billing'],
      groupId: payments,
      trigger: every(45),
      input: { type: 'static', config: { format: 'json', value: { status: 'pending' } } },
      target: viaStorefront('charge', {
        url: '/ledger/reconcile',
        headers: echoHeaders(80),
        assertions: { jsonPath: { path: '$.json.status', equals: 'balanced' } },
      }),
    },
    {
      name: 'Refresh partner token',
      description: 'The partner API is down, so every attempt gets a 503.',
      tags: ['partners'],
      trigger: every(40),
      target: viaStorefront('charge', { url: '/partners/token', headers: echoHeaders(60, 503) }),
      policy: { retry: { maxAttempts: 2, backoff: 'fixed', delayMs: 500 } },
    },
    {
      name: 'Export analytics',
      description:
        'Takes about seven seconds against a two-second SLA, so its runs are flagged late.',
      tags: ['reporting'],
      groupId: operations,
      trigger: every(60),
      target: viaStorefront('reports', {
        pathParams: { day: 'today' },
        headers: echoHeaders(7_000),
      }),
      policy: { sla: { maxDurationMs: 2_000 } },
    },
    {
      name: 'Send payout report',
      description: 'Weekday mornings in Ho Chi Minh City.',
      tags: ['reporting'],
      groupId: operations,
      trigger: {
        type: 'cron',
        config: { expression: 'H 9 * * MON-FRI', timezone: 'Asia/Ho_Chi_Minh' },
      },
      target: viaStorefront('reports', {
        pathParams: { day: 'payouts' },
        headers: echoHeaders(200),
      }),
    },
    {
      name: 'Month-end close',
      description: 'Last Friday of every month, skipping the year-end holiday.',
      tags: ['billing'],
      groupId: payments,
      trigger: {
        type: 'rrule',
        config: {
          rule: 'FREQ=MONTHLY;BYDAY=-1FR',
          start: '2026-01-30T18:00',
          timezone: 'Europe/London',
          exdates: ['2026-12-25'],
        },
      },
      target: viaStorefront('charge', { url: '/ledger/close', headers: echoHeaders(300) }),
    },
    {
      name: 'Order webhook',
      description: 'Runs for each order event posted to its webhook URL.',
      tags: ['orders'],
      trigger: {
        type: 'webhook',
        config: { token: WEBHOOK_TOKEN, rateLimit: { perSecond: 20 } },
      },
      input: { type: 'event', config: {} },
      target: viaStorefront('charge', { url: '/orders/fulfil', headers: echoHeaders(150) }),
    },
  ];
};

const afterInventory = (inventoryId: string): JobInput => ({
  name: 'Notify warehouse',
  description: 'Runs after every successful inventory sync.',
  tags: ['catalog'],
  trigger: { type: 'after_job', config: { jobId: inventoryId, on: ['succeeded'] } },
  target: viaStorefront('inventory', { url: '/warehouse/notify', headers: echoHeaders(90) }),
});

const step = (url: string, delayMs: number): InlineStep => ({
  target: viaStorefront('charge', { url, headers: echoHeaders(delayMs) }),
});

const releaseWorkflow: WorkflowInput = {
  name: 'Weekly price update',
  description: 'Builds new prices, checks them, waits for approval, then publishes or rolls back.',
  nodes: [
    { key: 'build', label: 'Build price list', kind: 'inline', job: step('/prices/build', 400) },
    { key: 'check', label: 'Check margins', kind: 'inline', job: step('/prices/check', 250) },
    { key: 'approve', label: 'Finance approval', kind: 'approval', timeoutMs: DAY_MS },
    { key: 'publish', label: 'Publish prices', kind: 'inline', job: step('/prices/publish', 300) },
    { key: 'rollback', label: 'Roll back', kind: 'inline', job: step('/prices/rollback', 200) },
    { key: 'alert', label: 'Alert pricing team', kind: 'inline', job: step('/prices/alert', 100) },
  ],
  edges: [
    { from: 'build', to: 'check' },
    { from: 'check', to: 'approve' },
    { from: 'check', to: 'alert', on: 'failed' },
    { from: 'approve', to: 'publish' },
    { from: 'publish', to: 'rollback', on: 'failed' },
  ],
};

export async function seedDemo(api: ApiClient, options: SeedDemoOptions): Promise<SeedDemoReport> {
  const created: string[] = [];
  const existing: string[] = [];
  const track = (name: string, isNew: boolean): void => {
    (isNew ? created : existing).push(name);
  };

  const connections = await api.connections.list({ search: STOREFRONT, limit: 100 });
  const hasStorefront = connections.items.some((c) => c.key === STOREFRONT);
  if (!hasStorefront) {
    await api.connections.create(storefront(options.targetUrl));
  }
  track(`connection ${STOREFRONT}`, !hasStorefront);

  const groupIds = new Map<string, string>();
  for (const spec of groups) {
    const found = (await api.groups.list({ search: spec.name, limit: 100 })).items.find(
      (g) => g.name === spec.name,
    );
    groupIds.set(spec.name, found?.id ?? (await api.groups.create(spec)).id);
    track(`group ${spec.name}`, found === undefined);
  }

  const workflow = (
    await api.workflows.list({ search: releaseWorkflow.name, limit: 100 })
  ).items.find((w) => w.name === releaseWorkflow.name);
  if (workflow === undefined) {
    const createdWorkflow = await api.workflows.create(releaseWorkflow);
    await api.workflows.run({ id: createdWorkflow.id });
  }
  track(`workflow ${releaseWorkflow.name}`, workflow === undefined);

  const ensureJob = async (spec: JobInput) => {
    const found = (await api.jobs.list({ search: spec.name, limit: 100 })).items.find(
      (j) => j.name === spec.name,
    );
    track(`job ${spec.name}`, found === undefined);

    return { job: found ?? (await api.jobs.create(spec)), isNew: found === undefined };
  };

  const ensured = new Map<string, Awaited<ReturnType<typeof ensureJob>>>();
  for (const spec of jobs(groupIds)) {
    ensured.set(spec.name, await ensureJob(spec));
  }
  const inventory = ensured.get('Sync inventory');
  if (inventory) {
    await ensureJob(afterInventory(inventory.job.id));
  }

  const payout = ensured.get('Send payout report');
  if (payout?.isNew) {
    await api.jobs.backfill({
      id: payout.job.id,
      from: new Date(options.now.getTime() - 7 * DAY_MS).toISOString(),
      to: options.now.toISOString(),
    });
  }

  const webhook = ensured.get('Order webhook');
  if (webhook?.isNew) {
    for (const order of ['A-1001', 'A-1002', 'A-1003']) {
      const response = await fetch(
        `${options.serverUrl}/hooks/${webhook.job.id}/${WEBHOOK_TOKEN}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': order },
          body: JSON.stringify({ type: 'order.paid', order }),
        },
      );
      if (!response.ok) {
        throw new Error(`Webhook delivery ${order} answered ${response.status}`);
      }
    }
  }

  return { created, existing };
}
