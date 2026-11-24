import 'reflect-metadata';
import type { ConfigIssue } from '@cloud-trigger/core';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { apiReference } from '@scalar/nestjs-api-reference';
import { Logger } from 'nestjs-pino';
import { pino } from 'pino';

import { AppModule } from './app.module.js';
import { type AppConfig, databaseConfig, loadConfig } from './config/config.js';
import { createPino } from './infra/logging/logger.js';
import { probeDatabase } from './infra/persistence/persistence.js';
import { SetupAppModule } from './setup-app.module.js';

const REPROBE_MS = 10_000;

type Pino = ReturnType<typeof createPino>;

async function databaseIssues(config: AppConfig): Promise<ConfigIssue[]> {
  const database = databaseConfig(config);
  if (database.isErr()) {
    return database.error;
  }
  const error = await probeDatabase(database.value);

  return error === undefined ? [] : [{ path: 'DB_DRIVER', message: `Cannot connect: ${error}` }];
}

async function listen(app: INestApplication, config: AppConfig): Promise<void> {
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  if (config.CORS_ORIGINS.length > 0) {
    app.enableCors({ origin: config.CORS_ORIGINS, credentials: true });
  }
  await app.listen(config.PORT, '0.0.0.0');
}

async function runSetupUntilDatabaseAnswers(
  config: AppConfig,
  logger: Pino,
  issues: ConfigIssue[],
): Promise<void> {
  const app = await NestFactory.create(SetupAppModule.forRoot({ config, pino: logger, issues }), {
    bufferLogs: true,
    bodyParser: false,
  });
  await listen(app, config);
  logger.warn({ port: config.PORT, issues }, 'No usable database; serving the setup wizard');
  if (databaseConfig(config).isErr()) {
    return new Promise<void>(() => undefined);
  }
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, REPROBE_MS));
    if ((await databaseIssues(config)).length === 0) {
      logger.info('Database is reachable; starting Cloud Trigger');
      await app.close();

      return;
    }
  }
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createPino({ level: config.LOG_LEVEL, base: { instance: config.INSTANCE_ID } });

  const issues = await databaseIssues(config);
  if (issues.length > 0) {
    if (!config.APP_ROLE.includes('api')) {
      throw new Error(`No usable database: ${issues.map((i) => i.message).join('; ')}`);
    }
    await runSetupUntilDatabaseAnswers(config, logger, issues);
  }

  const app = await NestFactory.create(AppModule.forRoot({ config, pino: logger }), {
    bufferLogs: true,
    bodyParser: false,
  });
  if (config.APP_ROLE.includes('api')) {
    app.use('/docs', apiReference({ url: '/api/openapi.json', theme: 'purple' }));
  }
  await listen(app, config);
  logger.info({ port: config.PORT, roles: config.APP_ROLE }, 'Cloud Trigger listening');
}

bootstrap().catch((error: unknown) => {
  pino(pino.destination({ dest: 2, sync: true })).fatal(
    { err: error },
    'Cloud Trigger failed to start',
  );
  process.exit(1);
});
