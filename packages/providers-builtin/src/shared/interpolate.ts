import { ResultAsync, type SecretResolver } from '@cloud-trigger/core';

export const interpolate = (secrets: SecretResolver, text: string) =>
  new ResultAsync(secrets.interpolate(text));

export const interpolateValues = (secrets: SecretResolver, values: Record<string, string>) =>
  ResultAsync.combine(
    Object.entries(values).map(([key, value]) =>
      interpolate(secrets, value).map((resolved) => [key, resolved] as const),
    ),
  ).map((entries) => Object.fromEntries(entries));
