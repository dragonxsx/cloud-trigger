import { type DynamicModule, Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';

const SERVER_PATHS = [
  '/api/{*path}',
  '/health/{*path}',
  '/metrics',
  '/docs/{*path}',
  '/badges/{*path}',
  '/calendar.ics',
  '/hooks/{*path}',
  '/mcp',
];

@Module({})
export class WebModule {
  static forRoot(rootPath: string): DynamicModule {
    return {
      module: WebModule,
      imports: [ServeStaticModule.forRoot({ rootPath, exclude: SERVER_PATHS })],
    };
  }
}
