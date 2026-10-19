import { isRecord } from './guards.js';

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) {
    return patch;
  }
  const base = isRecord(target) ? target : {};
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = mergePatch(base[key], value);
    }
  }

  return merged;
}
