import type { ProviderPlugin } from '@cloud-trigger/core';

import { staticInput } from './inputs/static.js';
import { templateInput } from './inputs/template.js';
import { emailNotifier } from './notifiers/email.js';
import { slackNotifier } from './notifiers/slack.js';
import { webhookNotifier } from './notifiers/webhook.js';
import { httpTarget } from './targets/http.js';
import { afterJobTrigger } from './triggers/after-job.js';
import { cronTrigger } from './triggers/cron.js';
import { intervalTrigger } from './triggers/interval.js';
import { onceTrigger } from './triggers/once.js';
import { rruleTrigger } from './triggers/rrule.js';

export {
  afterJobTrigger,
  cronTrigger,
  emailNotifier,
  httpTarget,
  intervalTrigger,
  onceTrigger,
  rruleTrigger,
  slackNotifier,
  staticInput,
  templateInput,
  webhookNotifier,
};
export {
  createEmailNotifier,
  type MailTransport,
  type SmtpSettings,
  type TransportFactory,
} from './notifiers/email.js';
export { expandHashTokens } from './triggers/hash-expression.js';

export const builtinProviders: ProviderPlugin = {
  name: '@cloud-trigger/providers-builtin',
  register: (registry) => {
    registry.register(
      cronTrigger,
      intervalTrigger,
      onceTrigger,
      rruleTrigger,
      afterJobTrigger,
      staticInput,
      templateInput,
      httpTarget,
      webhookNotifier,
      slackNotifier,
      emailNotifier,
    );
  },
};
