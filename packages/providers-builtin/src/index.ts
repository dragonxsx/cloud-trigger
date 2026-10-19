import type { ProviderPlugin } from '@cloud-trigger/core';

import { httpConnection } from './connections/http.js';
import { eventInput } from './inputs/event.js';
import { staticInput } from './inputs/static.js';
import { templateInput } from './inputs/template.js';
import { emailNotifier } from './notifiers/email.js';
import { slackNotifier } from './notifiers/slack.js';
import { webhookNotifier } from './notifiers/webhook.js';
import { graphqlTarget } from './targets/graphql.js';
import { httpTarget } from './targets/http.js';
import { afterJobTrigger } from './triggers/after-job.js';
import { cronTrigger } from './triggers/cron.js';
import { intervalTrigger } from './triggers/interval.js';
import { manualTrigger } from './triggers/manual.js';
import { onceTrigger } from './triggers/once.js';
import { rruleTrigger } from './triggers/rrule.js';
import { webhookTrigger } from './triggers/webhook.js';

export {
  afterJobTrigger,
  httpConnection,
  eventInput,
  webhookTrigger,
  cronTrigger,
  emailNotifier,
  graphqlTarget,
  httpTarget,
  intervalTrigger,
  manualTrigger,
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
export { templateScope } from './inputs/template.js';
export {
  HttpAuth,
  HttpConnectionConfig,
  clearHttpTokenCache,
  isRelativeUrl,
  joinUrl,
} from './connections/http.js';
export { FANOUT_TYPE, type FanoutConfig, createFanoutTarget } from './targets/fanout.js';
export { interpolate, interpolateValues } from './shared/interpolate.js';
export { LiquidTemplate, renderWithSecrets } from './shared/liquid.js';
export {
  SigningConfig,
  constantTimeEquals,
  signatureHeaders,
  verifySignature,
} from './shared/signing.js';
export {
  HttpAssertions,
  JsonPathAssertion,
  StatusPattern,
  firstFailedAssertion,
  jsonPathFailure,
  matchesStatus,
} from './targets/http-assertions.js';

export const builtinProviders: ProviderPlugin = {
  name: '@cloud-trigger/providers-builtin',
  register: (registry) => {
    registry.register(
      httpConnection,
      cronTrigger,
      intervalTrigger,
      onceTrigger,
      rruleTrigger,
      afterJobTrigger,
      webhookTrigger,
      manualTrigger,
      staticInput,
      eventInput,
      templateInput,
      httpTarget,
      graphqlTarget,
      webhookNotifier,
      slackNotifier,
      emailNotifier,
    );
  },
};
