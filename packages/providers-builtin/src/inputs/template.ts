import { type RunContext, defineInput } from '@cloud-trigger/core';
import { z } from 'zod';

import { LiquidTemplate, renderWithSecrets } from '../shared/liquid.js';

export const TemplateInputConfig = z.object({
  template: LiquidTemplate.describe(
    'Liquid template. Variables: run.*, now, parent (chained runs). Filter: {{ "NAME" | secret }}',
  ),
  contentType: z.string().default('application/json'),
  attributes: z.record(z.string(), LiquidTemplate).default({}),
});

const scopeFor = (ctx: RunContext) => ({
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
  renderWithSecrets(template, scopeFor(ctx), ctx.secrets);

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
