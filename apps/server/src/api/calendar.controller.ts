import { contract } from '@cloud-trigger/api-contract';
import { Controller, Inject } from '@nestjs/common';
import { Implement } from '@orpc/nest';

import type { AppContext } from '../app-context.js';
import { CalendarTokens } from '../auth/calendar-tokens.js';
import { APP_CONTEXT } from '../tokens.js';
import { type Api, createApi } from './api.js';

@Controller()
export class CalendarController {
  readonly #api: Api;
  readonly #tokens: CalendarTokens;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#api = createApi(ctx);
    this.#tokens = new CalendarTokens(ctx.config.CALENDAR_TOKEN_SECRET);
  }

  @Implement(contract.calendar)
  calendar() {
    return {
      token: this.#api.calendar.token.handler(({ context, errors }) => {
        const token = this.#tokens.issue(context.principal.subject);
        if (token === undefined) {
          throw errors.CONFLICT({ message: 'Set CALENDAR_TOKEN_SECRET to enable calendar tokens' });
        }
        const base = this.ctx.config.PUBLIC_URL ?? `http://localhost:${this.ctx.config.PORT}`;
        const url = new URL('/calendar.ics', base);
        url.searchParams.set('token', token);

        return { token, url: url.toString() };
      }),
    };
  }
}
