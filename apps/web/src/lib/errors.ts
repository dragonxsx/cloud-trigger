import { ConfigIssue } from '@cloud-trigger/api-contract';
import { showNotification } from '@mantine/notifications';
import { ORPCError } from '@orpc/client';
import type { ReactNode } from 'react';
import { z } from 'zod';

export type ConfigIssueDto = z.output<typeof ConfigIssue>;
const InvalidConfigData = z.object({ issues: z.array(ConfigIssue) });

export function configIssues(error: unknown): readonly ConfigIssueDto[] {
  if (!(error instanceof ORPCError) || error.code !== 'INVALID_CONFIG') {
    return [];
  }
  const parsed = InvalidConfigData.safeParse(error.data);

  return parsed.success ? parsed.data.issues : [];
}

export const isUnauthorized = (error: unknown): boolean =>
  error instanceof ORPCError && error.code === 'UNAUTHORIZED';

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong';

export const notifyError = (title: string, error: unknown): void => {
  showNotification({ color: 'red', title, message: errorMessage(error) });
};

export const configIssuesFor = (
  errors: Record<string, ReactNode>,
  prefix: string,
): ConfigIssueDto[] =>
  Object.entries(errors).flatMap(([path, message]) =>
    path.startsWith(`${prefix}.config`) && typeof message === 'string'
      ? [{ path: path.slice(`${prefix}.config`.length).replace(/^\./, ''), message }]
      : [],
  );

export const fieldError = (errors: Record<string, ReactNode>, path: string): string | undefined => {
  const message = errors[path];

  return typeof message === 'string' ? message : undefined;
};
