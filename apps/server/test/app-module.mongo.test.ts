import { NestFactory } from '@nestjs/core';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiRouter } from '../src/api/app-router.js';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { EngineRuntime } from '../src/engine/engine-runtime.js';
import { TEST_ENCRYPTION_KEY } from './support/app.js';
import { mongoEnv } from './support/databases.js';

const closers: (() => Promise<void>)[] = [];

const boot = async (role: string) => {
  const config = loadConfig({
    DATA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    APP_ROLE: role,
    ...mongoEnv('app_module'),
  });
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot({ config, pino: pino({ level: 'silent' }) }),
    { logger: false },
  );
  closers.push(() => app.close());

  return app;
};

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('AppModule role gating', { timeout: 20_000 }, () => {
  it('leaves out the API and scheduler loops for a worker', async () => {
    const app = await boot('worker');
    const runtime = app.get(EngineRuntime);

    expect(() => app.get(ApiRouter)).toThrow(/ApiRouter/);
    expect(runtime.hasWorker).toBe(true);
    expect(runtime.loopCount).toBe(1);
  });

  it('wires the API router for the api role without engine loops', async () => {
    const app = await boot('api');
    const runtime = app.get(EngineRuntime);

    expect(Object.keys(app.get(ApiRouter).router)).toContain('jobs');
    expect(runtime.hasWorker).toBe(false);
    expect(runtime.loopCount).toBe(0);
  });
});
