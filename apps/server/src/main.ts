import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { apiReference } from '@scalar/nestjs-api-reference';
import { Logger } from 'nestjs-pino';
import { pino } from 'pino';

import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.js';
import { createPino } from './infra/logging/logger.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createPino({ level: config.LOG_LEVEL, base: { instance: config.INSTANCE_ID } });

  const app = await NestFactory.create(AppModule.forRoot({ config, pino: logger }), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  if (config.CORS_ORIGINS.length > 0) {
    app.enableCors({ origin: config.CORS_ORIGINS, credentials: true });
  }
  if (config.APP_ROLE.includes('api')) {
    app.use('/docs', apiReference({ url: '/api/openapi.json', theme: 'purple' }));
  }
  await app.listen(config.PORT, '0.0.0.0');
  logger.info({ port: config.PORT, roles: config.APP_ROLE }, 'Cloud Trigger listening');
}

bootstrap().catch((error: unknown) => {
  pino(pino.destination({ dest: 2, sync: true })).fatal(
    { err: error },
    'Cloud Trigger failed to start',
  );
  process.exit(1);
});
