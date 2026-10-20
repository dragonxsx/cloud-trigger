import { isRecord } from '@cloud-trigger/core';
import { getSegmentsFromPath } from '@scalar/json-magic/helpers/get-segments-from-path';
import { getValueByPath } from '@scalar/json-magic/helpers/get-value-by-path';

const MAX_HOPS = 16;

const pointer = (root: unknown, path: string): unknown => {
  try {
    const found: unknown = getValueByPath(root, getSegmentsFromPath(path)).value;

    return found;
  } catch {
    return undefined;
  }
};

export type Warn = (path: string, message: string) => void;

export function resolveLocal(root: unknown, value: unknown, at: string, warn: Warn): unknown {
  let current = value;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const ref = isRecord(current) ? current['$ref'] : undefined;
    if (typeof ref !== 'string') {
      return current;
    }
    if (!ref.startsWith('#/')) {
      warn(at, `External reference "${ref}" is not followed`);

      return undefined;
    }
    current = pointer(root, ref.slice(1));
    if (current === undefined) {
      warn(at, `Reference "${ref}" does not exist`);

      return undefined;
    }
  }
  warn(at, 'Reference chain is too long or circular');

  return undefined;
}
