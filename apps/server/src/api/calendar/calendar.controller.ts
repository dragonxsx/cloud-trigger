import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import { CalendarRouter } from './calendar.router.js';

@Controller()
export class CalendarController {
  constructor(@Inject(CalendarRouter) private readonly router: CalendarRouter) {}

  @Implement(contract.calendar)
  calendar() {
    return this.router.handlers;
  }
}
