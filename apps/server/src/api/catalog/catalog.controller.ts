import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { CatalogRouter } from './catalog.router.js';

@Controller()
export class CatalogController {
  constructor(@Inject(CatalogRouter) private readonly router: CatalogRouter) {}

  @Implement(contract.providers)
  providers() {
    return this.router.handlers;
  }
}
