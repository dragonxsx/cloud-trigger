import { isRecord } from '../shared/guards.js';
import type { JsonSchema } from './sdk.js';

export const REDACTED = '***';

const discriminatorMatches = (branch: JsonSchema | boolean, value: unknown): boolean => {
  if (typeof branch === 'boolean' || branch.properties === undefined || !isRecord(value)) {
    return true;
  }

  return Object.entries(branch.properties).every(
    ([key, property]) =>
      typeof property === 'boolean' ||
      property.const === undefined ||
      value[key] === undefined ||
      value[key] === property.const,
  );
};

const schemaBranches = (schema: JsonSchema, value: unknown): readonly (JsonSchema | boolean)[] => [
  ...[...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].filter((branch) =>
    discriminatorMatches(branch, value),
  ),
  ...(schema.allOf ?? []),
];

const propertySchema = (schema: JsonSchema, key: string): JsonSchema | boolean | undefined =>
  schema.properties?.[key] ?? schema.additionalProperties;

const describesMembers = (schema: JsonSchema): boolean =>
  schema.properties !== undefined || typeof schema.additionalProperties === 'object';

export function mapSecrets(
  schema: JsonSchema | boolean | undefined,
  value: unknown,
  leaf: (secret: unknown) => unknown,
): unknown {
  if (schema === undefined || typeof schema === 'boolean') {
    return value;
  }
  if (schema['secret'] === true) {
    return leaf(value);
  }

  const result = schemaBranches(schema, value).reduce<unknown>(
    (current, branch) => mapSecrets(branch, current, leaf),
    value,
  );

  if (isRecord(result) && describesMembers(schema)) {
    return Object.fromEntries(
      Object.entries(result).map(([key, v]) => [
        key,
        mapSecrets(propertySchema(schema, key), v, leaf),
      ]),
    );
  }
  if (Array.isArray(result) && schema.items !== undefined && !Array.isArray(schema.items)) {
    const items = schema.items;

    return result.map((item: unknown) => mapSecrets(items, item, leaf));
  }

  return result;
}

export const redactSecret = (value: unknown): unknown =>
  value === undefined || value === null ? value : REDACTED;

export const redactBySchema = (schema: JsonSchema | boolean | undefined, value: unknown): unknown =>
  mapSecrets(schema, value, redactSecret);

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

  const result = schemaBranches(schema, next).reduce<unknown>(
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
