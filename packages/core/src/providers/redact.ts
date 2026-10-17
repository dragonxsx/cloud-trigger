import { isRecord } from '../shared/guards.js';
import type { JsonSchema } from './sdk.js';

export const REDACTED = '***';

const schemaBranches = (schema: JsonSchema): readonly (JsonSchema | boolean)[] => [
  ...(schema.anyOf ?? []),
  ...(schema.oneOf ?? []),
  ...(schema.allOf ?? []),
];

const propertySchema = (schema: JsonSchema, key: string): JsonSchema | boolean | undefined =>
  schema.properties?.[key] ?? schema.additionalProperties;

const describesMembers = (schema: JsonSchema): boolean =>
  schema.properties !== undefined || typeof schema.additionalProperties === 'object';

export function redactBySchema(schema: JsonSchema | boolean | undefined, value: unknown): unknown {
  if (schema === undefined || typeof schema === 'boolean') {
    return value;
  }
  if (schema['secret'] === true) {
    return value === undefined ? value : REDACTED;
  }

  const result = schemaBranches(schema).reduce<unknown>(
    (current, branch) => redactBySchema(branch, current),
    value,
  );

  if (isRecord(result) && describesMembers(schema)) {
    return Object.fromEntries(
      Object.entries(result).map(([key, v]) => [
        key,
        redactBySchema(propertySchema(schema, key), v),
      ]),
    );
  }
  if (Array.isArray(result) && schema.items !== undefined && !Array.isArray(schema.items)) {
    const items = schema.items;

    return result.map((item: unknown) => redactBySchema(items, item));
  }

  return result;
}

export function restoreRedacted(
  schema: JsonSchema | boolean | undefined,
  next: unknown,
  previous: unknown,
): unknown {
  if (schema === undefined || typeof schema === 'boolean') {
    return next;
  }
  if (schema['secret'] === true) {
    return next === REDACTED ? previous : next;
  }

  const result = schemaBranches(schema).reduce<unknown>(
    (current, branch) => restoreRedacted(branch, current, previous),
    next,
  );
  if (isRecord(result) && describesMembers(schema)) {
    const prev = isRecord(previous) ? previous : {};

    return Object.fromEntries(
      Object.entries(result).map(([key, v]) => [
        key,
        restoreRedacted(propertySchema(schema, key), v, prev[key]),
      ]),
    );
  }
  if (Array.isArray(result) && schema.items !== undefined && !Array.isArray(schema.items)) {
    const items = schema.items;
    const prev = Array.isArray(previous) ? previous : [];

    return result.map((item: unknown, i) => restoreRedacted(items, item, prev[i]));
  }

  return result;
}
