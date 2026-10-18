import type { CalendarTokens } from '../../auth/calendar-tokens.js';
import type { AppConfig } from '../../config/config.js';
import type { Api } from '../shared/api.js';

export interface CalendarRouterDeps {
  readonly api: Api;
  readonly tokens: CalendarTokens;
  readonly config: AppConfig;
}

export const calendarHandlers = ({ api, tokens, config }: CalendarRouterDeps) => {
  return {
    token: api.calendar.token.handler(({ context, errors }) => {
      const token = tokens.issue(context.principal.subject);
      if (token === undefined) {
        throw errors.CONFLICT({ message: 'Set CALENDAR_TOKEN_SECRET to enable calendar tokens' });
      }
      const base = config.PUBLIC_URL ?? `http://localhost:${config.PORT}`;
      const url = new URL('/calendar.ics', base);
      url.searchParams.set('token', token);

      return { token, url: url.toString() };
    }),
  };
};

export class CalendarRouter {
  constructor(readonly handlers: ReturnType<typeof calendarHandlers>) {}
}
