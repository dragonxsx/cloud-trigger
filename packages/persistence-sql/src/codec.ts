import { isRecord } from '@cloud-trigger/core';
import { z } from 'zod';

const DATE_TAG = '$date';

const tagDates = (value: unknown): unknown => {
  if (value instanceof Date) {
    return { [DATE_TAG]: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map(tagDates);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        item === undefined ? [] : [[key, tagDates(item)]],
      ),
    );
  }

  return value;
};

const reviveDates = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(reviveDates);
  }
  if (isRecord(value)) {
    const tagged = value[DATE_TAG];
    if (typeof tagged === 'string' && Object.keys(value).length === 1) {
      return new Date(tagged);
    }

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveDates(item)]));
  }

  return value;
};

export const encodeDoc = (value: unknown): string => JSON.stringify(tagDates(value));

const parseJson = (text: string): unknown => {
  const parsed: unknown = JSON.parse(text);

  return parsed;
};

export const decodeDoc = (stored: unknown): unknown =>
  reviveDates(typeof stored === 'string' ? parseJson(stored) : stored);

export const epoch = (date: Date): number => date.getTime();
export const epochOrNull = (date: Date | null | undefined): number | null =>
  date === null || date === undefined ? null : date.getTime();

export const Epoch = z
  .union([z.number(), z.string(), z.bigint()])
  .transform((value) => Number(value));
export const DateColumn = Epoch.transform((value) => new Date(value));
export const Flag = z
  .union([z.number(), z.boolean(), z.string(), z.bigint()])
  .transform((value) => value === true || Number(value) === 1);
export const Count = z.object({ count: Epoch });

export const flag = (value: boolean): number => (value ? 1 : 0);

export const DocRow = z.looseObject({ doc: z.unknown() });

export const docParser =
  <S extends z.ZodType>(schema: S) =>
  (row: Readonly<Record<string, unknown>>): z.output<S> =>
    schema.parse(decodeDoc(DocRow.parse(row).doc));
