import type { Persistence } from '@cloud-trigger/core';

import type { Api } from '../shared/api.js';

export interface AnalyticsRouterDeps {
  readonly api: Api;
  readonly analytics: Persistence['analytics'];
}

export const analyticsHandlers = ({ api: { analytics: api }, analytics }: AnalyticsRouterDeps) => {
  return {
    summary: api.summary.handler(({ input }) => analytics.summary(input)),
    timeseries: api.timeseries.handler(async ({ input }) => [
      ...(await analytics.timeseries(input)),
    ]),
    topErrors: api.topErrors.handler(async ({ input }) => [...(await analytics.topErrors(input))]),
  };
};

export class AnalyticsRouter {
  constructor(readonly handlers: ReturnType<typeof analyticsHandlers>) {}
}
