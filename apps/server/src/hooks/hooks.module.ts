import { Module } from '@nestjs/common';

import { EngineModule } from '../engine/engine.module.js';
import { HooksController } from './hooks.controller.js';

@Module({
  imports: [EngineModule],
  controllers: [HooksController],
})
export class HooksModule {}
