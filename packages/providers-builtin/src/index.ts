import type { ProviderPlugin } from '@cloud-trigger/core';

import { staticInput } from './inputs/static.js';
import { templateInput } from './inputs/template.js';
import { httpTarget } from './targets/http.js';
import { cronTrigger } from './triggers/cron.js';
import { intervalTrigger } from './triggers/interval.js';
import { onceTrigger } from './triggers/once.js';

export { cronTrigger, httpTarget, intervalTrigger, onceTrigger, staticInput, templateInput };
export { expandHashTokens } from './triggers/hash-expression.js';

export const builtinProviders: ProviderPlugin = {
  name: '@cloud-trigger/providers-builtin',
  register: (registry) => {
    registry.register(
      cronTrigger,
      intervalTrigger,
      onceTrigger,
      staticInput,
      templateInput,
      httpTarget,
    );
  },
};
