import { Result, type RunContext, defineInput } from '@cloud-trigger/core';
import { Liquid } from 'liquidjs';
import { z } from 'zod';

const validationEngine = new Liquid({ strictFilters: true, strictVariables: true, cache: true });
validationEngine.registerFilter('secret', (name: unknown) => name);

const tryParse = Result.fromThrowable((template: string) => validationEngine.parse(template));
const isValidTemplate = (template: string): boolean => tryParse(template).isOk();

const LiquidTemplate = z.string().refine(isValidTemplate, 'Invalid Liquid template');

export const TemplateInputConfig = z.object({
  template: LiquidTemplate.describe(
    'Liquid template. Variables: run.*, now. Filter: {{ "NAME" | secret }}',
  ),
  contentType: z.string().default('application/json'),
  attributes: z.record(z.string(), LiquidTemplate).default({}),
});

const scopeFor = (ctx: RunContext) => ({
  now: ctx.now.toISOString(),
  run: {
    id: ctx.runId,
    jobId: ctx.jobId,
    jobName: ctx.jobName,
    attempt: ctx.attempt,
    reason: ctx.reason,
    scheduledAt: ctx.scheduledAt.toISOString(),
  },
});

const renderWithSecrets = async (template: string, ctx: RunContext): Promise<string> => {
  const engine = new Liquid({ strictFilters: true, strictVariables: true });
  engine.registerFilter('secret', async (name: unknown) => {
    const value = typeof name === 'string' ? await ctx.secrets.get(name) : undefined;
    if (value === undefined) {
      throw new Error(`Missing secret "${String(name)}"`);
    }

    return value;
  });
  const output: unknown = await engine.parseAndRender(template, scopeFor(ctx));

  return String(output);
};

export const templateInput = defineInput({
  type: 'template',
  displayName: 'Template',
  description: 'Renders a Liquid template per run (timestamps, run metadata, secrets).',
  configSchema: TemplateInputConfig,
  resolve: async (config, ctx) => {
    const entries = await Promise.all(
      Object.entries(config.attributes).map(
        async ([key, tpl]) => [key, await renderWithSecrets(tpl, ctx)] as const,
      ),
    );

    return {
      body: await renderWithSecrets(config.template, ctx),
      contentType: config.contentType,
      attributes: Object.fromEntries(entries),
    };
  },
});
