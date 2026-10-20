import { type Result, err, ok } from '@cloud-trigger/core';

const PLACEHOLDER = /(?<!\{)\{([A-Za-z0-9_.-]+)\}(?!\})/g;

export interface PathParamFailure {
  readonly code: 'missing_path_param';
  readonly message: string;
  readonly retryable: false;
}

export const pathParamNames = (url: string): string[] =>
  [...url.matchAll(PLACEHOLDER)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

export function fillPathParams(
  url: string,
  params: Readonly<Record<string, string>>,
): Result<string, PathParamFailure> {
  const missing = pathParamNames(url).filter((name) => (params[name] ?? '') === '');
  if (missing.length > 0) {
    return err({
      code: 'missing_path_param',
      message: `No value for path parameter ${missing.map((name) => `{${name}}`).join(', ')}; set pathParams`,
      retryable: false,
    });
  }

  return ok(url.replace(PLACEHOLDER, (_, name: string) => encodeURIComponent(params[name] ?? '')));
}
