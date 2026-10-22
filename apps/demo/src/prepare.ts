import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';
import { z } from 'zod';

import { type ApiClient, createApiClient } from './api-client.js';
import { DEMO_ADMIN } from './demo-admin.js';
import { seedDemo } from './seed-demo.js';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const DATA_DIR = resolve(PACKAGE_ROOT, '.data');
const SERVER_ENTRY = resolve(REPO_ROOT, 'apps/server/dist/main.js');
const WEB_DIST = resolve(REPO_ROOT, 'apps/web/dist');
const COMPOSE_FILE = resolve(REPO_ROOT, 'deploy/docker-compose.yml');

const PrepareOptions = z.object({
  port: z.coerce.number().int().min(1).max(65_535),
  target: z.url(),
  echo: z.boolean(),
});
type PrepareOptions = z.output<typeof PrepareOptions>;

const readOrCreate = (file: string, create: () => string): string => {
  const path = resolve(DATA_DIR, file);
  if (!existsSync(path)) {
    writeFileSync(path, create());
  }

  return readFileSync(path, 'utf8').trim();
};

const requireBuilt = (path: string): void => {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; run "pnpm build" first`);
  }
};

const startEcho = (): void => {
  const result = spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, '--profile', 'demo', 'up', '-d', 'echo'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error('Could not start the echo target with docker compose; pass --no-echo to skip');
  }
};

const startServer = (port: number): ChildProcess => {
  const log = createWriteStream(resolve(DATA_DIR, 'server.log'), { flags: 'a' });
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: resolve(REPO_ROOT, 'apps/server'),
    env: {
      ...process.env,
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: resolve(DATA_DIR, 'demo.db'),
      APP_ROLE: 'all',
      PORT: String(port),
      WEB_DIST,
      SETUP_TOKEN: readOrCreate('setup-token', () => randomBytes(16).toString('hex')),
      DATA_ENCRYPTION_KEY: readOrCreate('encryption-key', () => randomBytes(32).toString('base64')),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);

  return server;
};

const waitUntilReady = async (url: string, server: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`The server exited with code ${server.exitCode}; see .data/server.log`);
    }
    const ready = await fetch(`${url}/health/live`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) {
      return;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('The server did not become ready within 60 seconds; see .data/server.log');
};

const adminApiKey = async (url: string): Promise<string> => {
  const anonymous = createApiClient(url);
  const { stage } = await anonymous.setup.status({});
  const session =
    stage === 'auth'
      ? await anonymous.setup.complete({
          token: readOrCreate('setup-token', () => randomBytes(16).toString('hex')),
          admin: DEMO_ADMIN,
          methods: {},
        })
      : await anonymous.auth.login(DEMO_ADMIN);
  const admin: ApiClient = createApiClient(url, { authorization: `Bearer ${session.token}` });

  return (
    await admin.apiKeys.create({ name: `demo seed ${new Date().toISOString()}`, scopes: ['admin'] })
  ).key;
};

async function prepare(options: PrepareOptions): Promise<void> {
  requireBuilt(SERVER_ENTRY);
  requireBuilt(WEB_DIST);
  mkdirSync(DATA_DIR, { recursive: true });
  if (options.echo) {
    startEcho();
  }

  const url = `http://localhost:${options.port}`;
  const server = startServer(options.port);
  server.once('exit', (code) => {
    process.exitCode = code ?? 0;
  });
  const stop = (): void => {
    server.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await waitUntilReady(url, server);
    const apiKey = await adminApiKey(url);
    const report = await seedDemo(createApiClient(url, { 'x-api-key': apiKey }), {
      targetUrl: options.target,
      serverUrl: url,
      now: new Date(),
    });
    process.stdout.write(
      `Seeded ${report.created.length} new and ${report.existing.length} existing demo resources.\n` +
        `Open ${url} and sign in as ${DEMO_ADMIN.username} / ${DEMO_ADMIN.password}. Ctrl+C stops the server.\n`,
    );
  } catch (error) {
    stop();
    throw error;
  }
}

new Command('cloud-trigger-demo-prepare')
  .description('Start a local demo server on SQLite, then seed it with demo data.')
  .option('--port <port>', 'Port for the demo server', '8080')
  .option('--target <url>', 'HTTP echo server the demo jobs call', 'http://localhost:8888')
  .option('--no-echo', 'Do not start the echo target with docker compose')
  .showHelpAfterError()
  .action((raw: unknown) => prepare(PrepareOptions.parse(raw)))
  .parseAsync()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
