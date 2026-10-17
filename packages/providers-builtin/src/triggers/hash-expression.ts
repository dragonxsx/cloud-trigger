import { hash } from 'node:crypto';

type FieldRange = readonly [min: number, max: number];

const SAFE_LAST_DAY_OF_MONTH = 28;

const FIELD_RANGES = {
  second: [0, 59],
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, SAFE_LAST_DAY_OF_MONTH],
  month: [1, 12],
  dayOfWeek: [0, 6],
} as const satisfies Record<string, FieldRange>;

const FIVE_FIELDS: readonly FieldRange[] = [
  FIELD_RANGES.minute,
  FIELD_RANGES.hour,
  FIELD_RANGES.dayOfMonth,
  FIELD_RANGES.month,
  FIELD_RANGES.dayOfWeek,
];
const SIX_FIELDS: readonly FieldRange[] = [FIELD_RANGES.second, ...FIVE_FIELDS];

const stableHash = (input: string): number => Number.parseInt(hash('sha1', input).slice(0, 8), 16);

const H_TOKEN = /^H(?:\((\d+)-(\d+)\))?(?:\/(\d+))?$/;

export const hasHashToken = (expression: string): boolean =>
  expression
    .trim()
    .split(/\s+/)
    .some((field) => H_TOKEN.test(field));

export function expandHashTokens(expression: string, seed: string): string {
  const fields = expression.trim().split(/\s+/);
  const ranges = fields.length === 6 ? SIX_FIELDS : FIVE_FIELDS;

  return fields
    .map((field, index) => {
      const match = H_TOKEN.exec(field);
      const range = ranges[index];
      if (!match || !range) {
        return field;
      }
      const [, lo, hi, step] = match;
      const min = lo === undefined ? range[0] : Number(lo);
      const max = hi === undefined ? range[1] : Number(hi);
      const spread = stableHash(`${seed}:${index}`);
      if (step !== undefined) {
        const n = Number(step);

        return `${min + (spread % n)}-${max}/${n}`;
      }

      return String(min + (spread % (max - min + 1)));
    })
    .join(' ');
}
