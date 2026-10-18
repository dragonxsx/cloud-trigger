import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ORPCModule, onError } from '@orpc/nest';
import { RequestHeadersPlugin } from '@orpc/server/plugins';
import { experimental_ZodSmartCoercionPlugin as ZodSmartCoercionPlugin } from '@orpc/zod/zod4';
import { LoggerModule } from 'nestjs-pino';

import { CalendarController } from './api/calendar.controller.js';
import { GroupsController } from './api/groups.controller.js';
import { HealthController } from './api/health.controller.js';
import { JobsController } from './api/jobs.controller.js';
import { AuthController, AnalyticsController, ProvidersController } from './api/misc.controller.js';
import { OpenApiController } from './api/openapi.controller.js';
import { RunsController } from './api/runs.controller.js';
import type { AppContext } from './app-context.js';
import { FeedsController } from './feeds/feeds.controller.js';
import { APP_CONTEXT } from './tokens.js';

@Injectable()
class AppLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  onApplicationBootstrap(): void {
    this.ctx.engine.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.ctx.engine.stop();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.ctx.persistence.close();
  }
}

const QUIET_PATHS = ['/health', '/metrics'];

@Module({})
export class AppModule {
  static forRoot(ctx: AppContext): DynamicModule {
    const servesApi = ctx.config.APP_ROLE.includes('api');
    const webDist = ctx.config.WEB_DIST;

    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            logger: ctx.pino,
            autoLogging: {
              ignore: (req) => QUIET_PATHS.some((p) => req.url?.startsWith(p) === true),
            },
          },
        }),
        ORPCModule.forRoot({
          context: {},
          plugins: [new RequestHeadersPlugin(), new ZodSmartCoercionPlugin()],
          interceptors: [
            onError((error) => {
              ctx.logger.debug('API procedure error', { err: error });
            }),
          ],
        }),
        ...(servesApi && webDist
          ? [
              ServeStaticModule.forRoot({
                rootPath: webDist,
                exclude: [
                  '/api/{*path}',
                  '/health/{*path}',
                  '/metrics',
                  '/docs/{*path}',
                  '/badges/{*path}',
                  '/calendar.ics',
                ],
              }),
            ]
          : []),
      ],
      controllers: [
        HealthController,
        ...(servesApi
          ? [
              JobsController,
              RunsController,
              GroupsController,
              CalendarController,
              FeedsController,
              AnalyticsController,
              ProvidersController,
              AuthController,
              OpenApiController,
            ]
          : []),
      ],
      providers: [{ provide: APP_CONTEXT, useValue: ctx }, AppLifecycle],
    };
  }
}
