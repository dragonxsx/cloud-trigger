import { type DynamicModule, Global, Module } from '@nestjs/common';

import { valueProvider } from '../common/tokens.js';
import type { AppConfig } from './config.js';

export class ConfigService {
  constructor(readonly values: AppConfig) {}
}

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [valueProvider(ConfigService, new ConfigService(config))],
      exports: [ConfigService],
    };
  }
}
