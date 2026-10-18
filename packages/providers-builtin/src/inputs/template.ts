import { Result, type RunContext, defineInput } from '@cloud-trigger/core';
import { z } from 'zod';

import { LiquidTemplate, renderWithSecrets } from '../shared/liquid.js';

export const TemplateInputConfig = z.object({
  template: LiquidTemplate.describe(
    'Liquid template. Variables: run.*, now, parent (chained runs), event (webhooks and queue messages: event.body, event.headers). Filter: {{ "NAME" | secret }}',
  ),
  contentType: z.string().default('application/json'),
  attributes: z.record(z.string(), LiquidTemplate).default({}),
});

const parseBody = (body: string): unknown => {
  const parsed = Result.fromThrowable((text: string): unknown => JSON.parse(text))(body);

  return parsed.isOk() ? parsed.value : body;
};

const eventScope = (ctx: RunContext) => {
  const event = ctx.trigger?.event;

  return event
    ? {
        kind: event.kind,
        source: event.source,
        id: event.id,
        headers: event.headers,
        body: parseBody(event.body),
        rawBody: event.body,
        receivedAt: event.receivedAt.toISOString(),
      }
    : null;
};

export const templateScope = (ctx: RunContext) => ({
  event: eventScope(ctx),
  now: ctx.now.toISOString(),
  parent: ctx.parent
    ? {
        runId: ctx.parent.runId,
        jobId: ctx.parent.jobId,
        jobName: ctx.parent.jobName,
        status: ctx.parent.status,
        result: ctx.parent.result,
      }
    : null,
  run: {
    id: ctx.runId,
    jobId: ctx.jobId,
    jobName: ctx.jobName,
    attempt: ctx.attempt,
    reason: ctx.reason,
    scheduledAt: ctx.scheduledAt.toISOString(),
  },
});

const render = (template: string, ctx: RunContext) =>
  renderWithSecrets(template, templateScope(ctx), ctx.secrets);

export const templateInput = defineInput({
  type: 'template',
  displayName: 'Template',
  description: 'Renders a Liquid template per run (timestamps, run metadata, secrets).',
  configSchema: TemplateInputConfig,
  resolve: async (config, ctx) => {
    const entries = await Promise.all(
      Object.entries(config.attributes).map(
        async ([key, tpl]) => [key, await render(tpl, ctx)] as const,
      ),
    );

    return {
      body: await render(config.template, ctx),
      contentType: config.contentType,
      attributes: Object.fromEntries(entries),
    };
  },
});
