import { defineConnection, secret } from '@cloud-trigger/core';
import { z } from 'zod';

export const SlackConnectionConfig = z.object({
  url: secret(z.string().min(1)).describe(
    'Slack incoming-webhook URL. Shown as *** and kept on edit. May be {{secret:NAME}}.',
  ),
});
export type SlackConnectionConfig = z.output<typeof SlackConnectionConfig>;

export const slackConnection = defineConnection({
  type: 'slack',
  displayName: 'Slack webhook',
  description:
    'A Slack incoming webhook. Testing only checks the configuration, because any request posts a message.',
  configSchema: SlackConnectionConfig,
});
