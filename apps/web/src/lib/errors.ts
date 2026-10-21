import { ConfigIssue } from '@cloud-trigger/api-contract';
import { showNotification } from '@mantine/notifications';
import { ORPCError } from '@orpc/client';
import type { HttpError } from '@refinedev/core';
import { sentenceCase } from 'change-case';
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

const HttpErrorShape = z.object({
  message: z.string(),
  statusCode: z.number(),
  errors: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.boolean()])).optional(),
});

export const fieldLabel = (path: string): string => {
  const last = path.split('.').findLast((segment) => !/^\d+$/.test(segment)) ?? path;

  return last === '' ? 'This form' : sentenceCase(last);
};

function issueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === 'too_small' && issue.origin === 'string' && Number(issue.minimum) <= 1) {
    return 'Required';
  }
  if (issue.code === 'too_small' && issue.origin === 'string') {
    return `Must be at least ${String(issue.minimum)} characters`;
  }
  if (issue.code === 'too_big' && issue.origin === 'string') {
    return `Must be at most ${String(issue.maximum)} characters`;
  }
  if (issue.code === 'too_small' && issue.origin === 'array' && Number(issue.minimum) <= 1) {
    return 'Add at least one';
  }
  if (issue.code === 'invalid_type' && issue.message.endsWith('received undefined')) {
    return 'Required';
  }
  if (issue.code === 'invalid_format' && issue.format === 'uuid') {
    return 'Not a valid id';
  }
  if (issue.code === 'invalid_format' && issue.format === 'url') {
    return 'Enter a full URL, e.g. https://example.com';
  }

  return issue.message;
}

const issuePath = (issue: z.core.$ZodIssue): string => issue.path.map(String).join('.');

const summarize = (fields: readonly { path: string; message: string }[]): string => {
  const [first, ...rest] = fields;
  if (!first) {
    return 'Check the form and try again.';
  }
  const lead = `${fieldLabel(first.path)}: ${first.message}`;

  return rest.length === 0 ? lead : `${lead} (and ${String(rest.length)} more)`;
};

const forbiddenMessage = (message: string): string => {
  const scope = /"(read|write|admin)"/.exec(message)?.[1];

  return scope === undefined
    ? "Your account isn't allowed to do this."
    : `Your account isn't allowed to do this. It needs the ${scope} scope.`;
};

function fromOrpc(
  error: { readonly status: number; readonly message: string },
  issues: readonly ConfigIssueDto[],
): HttpError {
  if (issues.length > 0) {
    return {
      message: summarize(issues),
      statusCode: error.status,
      errors: Object.fromEntries(issues.map((i) => [i.path, [i.message]])),
    };
  }
  if (error.status === 403) {
    return { message: forbiddenMessage(error.message), statusCode: 403 };
  }

  return { message: error.message, statusCode: error.status };
}

export function toHttpError(
  error: unknown,
  options: { notFoundOnInvalid?: boolean } = {},
): HttpError {
  if (error instanceof ORPCError) {
    const status: number = error.status;
    const message: string = error.message;

    return fromOrpc({ status, message }, configIssues(error));
  }
  if (error instanceof z.ZodError) {
    if (options.notFoundOnInvalid === true) {
      return { message: "That record doesn't exist, or it was deleted.", statusCode: 404 };
    }
    const fields = error.issues.map((issue) => ({
      path: issuePath(issue),
      message: issueMessage(issue),
    }));

    return {
      message: summarize(fields),
      statusCode: 400,
      errors: Object.fromEntries(fields.map((f) => [f.path, [f.message]])),
    };
  }
  const shaped = HttpErrorShape.safeParse(error);
  if (shaped.success) {
    const { message, statusCode, errors } = shaped.data;

    return errors === undefined ? { message, statusCode } : { message, statusCode, errors };
  }
  if (error instanceof TypeError) {
    return {
      message: "Couldn't reach the server. Check your connection and try again.",
      statusCode: 0,
    };
  }

  return {
    message: error instanceof Error ? error.message : 'Something went wrong',
    statusCode: 500,
  };
}

export const errorMessage = (error: unknown): string => toHttpError(error).message;

export const errorStatus = (error: unknown): number => toHttpError(error).statusCode;

export const isNotFound = (error: unknown): boolean => errorStatus(error) === 404;

export const isForbidden = (error: unknown): boolean => {
  const status = errorStatus(error);

  return status === 401 || status === 403;
};

export const isClientError = (error: unknown): boolean => {
  const status = errorStatus(error);

  return status >= 400 && status < 500;
};

export const shouldRetryQuery = (failureCount: number, error: unknown): boolean =>
  failureCount < 2 && !isClientError(error);

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

export function focusFirstInvalidField(root: ParentNode = document): void {
  window.requestAnimationFrame(() => {
    const field = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!field) {
      return;
    }
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    field.focus({ preventScroll: true });
  });
}
