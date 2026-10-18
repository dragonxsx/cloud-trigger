import type { Request } from 'express';

export const headersOf = (req: Request): Headers =>
  new Headers(
    Object.entries(req.headers).flatMap(([name, value]): [string, string][] =>
      value === undefined
        ? []
        : Array.isArray(value)
          ? value.map((v): [string, string] => [name, v])
          : [[name, value]],
    ),
  );

export const flatHeaders = (req: Request): Record<string, string> =>
  Object.fromEntries(
    Object.entries(req.headers).flatMap(([name, value]): [string, string][] =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
    ),
  );
