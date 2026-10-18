import { Result, type SecretResolver } from '@cloud-trigger/core';
import { Liquid } from 'liquidjs';
import { z } from 'zod';

const validationEngine = new Liquid({
  strictFilters: true,
  strictVariables: true,
  lenientIf: true,
  cache: true,
});
validationEngine.registerFilter('secret', (name: unknown) => name);

const tryParse = Result.fromThrowable((template: string) => validationEngine.parse(template));
const isValidTemplate = (template: string): boolean => tryParse(template).isOk();

export const LiquidTemplate = z.string().refine(isValidTemplate, 'Invalid Liquid template');

export const renderWithSecrets = async (
  template: string,
  scope: object,
  secrets: SecretResolver,
): Promise<string> => {
  const engine = new Liquid({ strictFilters: true, strictVariables: true, lenientIf: true });
  engine.registerFilter('secret', async (name: unknown) => {
    const value = typeof name === 'string' ? await secrets.get(name) : undefined;
    if (value === undefined) {
      throw new Error(`Missing secret "${String(name)}"`);
    }

    return value;
  });
  const output: unknown = await engine.parseAndRender(template, scope);

  return String(output);
};
