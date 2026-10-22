import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Command } from 'commander';
import { type Page, launch } from 'puppeteer-core';
import { z } from 'zod';

import { type ApiClient, createApiClient } from './api-client.js';
import { DEMO_ADMIN } from './demo-admin.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCHEMES = ['light', 'dark'] as const;

const ScreenshotOptions = z.object({
  url: z.url(),
  out: z.string().min(1),
  chrome: z.string().min(1),
  only: z.array(z.string()).optional(),
});
type ScreenshotOptions = z.output<typeof ScreenshotOptions>;

interface Shot {
  readonly name: string;
  readonly path: string;
  readonly settleMs?: number;
}

const firstId = (items: readonly { id: string }[], what: string): string => {
  const [item] = items;
  if (!item) {
    throw new Error(`No ${what} found; seed the demo first`);
  }

  return item.id;
};

const jobId = async (api: ApiClient, name: string): Promise<string> =>
  firstId(
    (await api.jobs.list({ search: name, limit: 100 })).items.filter((j) => j.name === name),
    `job "${name}"`,
  );

const shotsFor = async (api: ApiClient): Promise<readonly Shot[]> => {
  const charge = await jobId(api, 'Charge subscriptions');
  const reconcile = await jobId(api, 'Reconcile ledger');
  const failedRun = firstId(
    (await api.runs.list({ jobId: reconcile, status: 'failed', limit: 1 })).items,
    'failed run',
  );
  const workflowRun = firstId((await api.workflowRuns.list({ limit: 1 })).items, 'workflow run');

  return [
    { name: 'dashboard', path: '/', settleMs: 4_000 },
    { name: 'jobs', path: '/jobs' },
    { name: 'job', path: `/jobs/show/${charge}`, settleMs: 4_000 },
    { name: 'workflow-run', path: `/workflows/runs/${workflowRun}`, settleMs: 4_000 },
    { name: 'failed-runs', path: '/runs?view=failed' },
    { name: 'run', path: `/runs/show/${failedRun}` },
    { name: 'connection', path: '/connections/show/storefront' },
  ];
};

const signIn = async (page: Page, url: string): Promise<void> => {
  await page.goto(`${url}/login`, { waitUntil: 'load' });
  const username = await page.waitForSelector('::-p-aria(Username)', { timeout: 15_000 });
  await username?.type(DEMO_ADMIN.username);
  await page.type('input[type="password"]', DEMO_ADMIN.password);
  await page.click('button[type="submit"]');
  await page.waitForFunction("!location.pathname.startsWith('/login')", { timeout: 15_000 });
};

async function capture(options: ScreenshotOptions): Promise<void> {
  const session = await createApiClient(options.url).auth.login(DEMO_ADMIN);
  const api = createApiClient(options.url, { authorization: `Bearer ${session.token}` });
  const shots = (await shotsFor(api)).filter(
    (shot) => options.only === undefined || options.only.includes(shot.name),
  );
  mkdirSync(options.out, { recursive: true });

  const browser = await launch({
    executablePath: options.chrome,
    headless: true,
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1.5 },
  });
  try {
    const page = await browser.newPage();
    await signIn(page, options.url);
    for (const scheme of SCHEMES) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      for (const shot of shots) {
        await page.goto(`${options.url}${shot.path}`, { waitUntil: 'load' });
        await delay(shot.settleMs ?? 3_000);
        const file = resolve(options.out, `${shot.name}-${scheme}.png`);
        await page.screenshot({ path: file });
        process.stdout.write(`${file}\n`);
      }
    }
  } finally {
    await browser.close();
  }
}

new Command('cloud-trigger-demo-screenshots')
  .description('Capture light and dark screenshots of a seeded demo for the README and website.')
  .option('--url <url>', 'Demo server URL', 'http://localhost:8080')
  .option('--out <dir>', 'Output directory', resolve(REPO_ROOT, 'docs/assets/screenshots'))
  .option('--chrome <path>', 'Chrome or Chromium binary', process.env['CHROME_PATH'] ?? MAC_CHROME)
  .option('--only <names...>', 'Capture only these shots, e.g. dashboard job')
  .showHelpAfterError()
  .action((raw: unknown) => capture(ScreenshotOptions.parse(raw)))
  .parseAsync()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
