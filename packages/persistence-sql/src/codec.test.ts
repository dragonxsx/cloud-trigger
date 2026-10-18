import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { decodeDoc, encodeDoc } from './codec.js';
import { compile } from './compile.js';
import { likePattern } from './query.js';

describe('document codec', () => {
  it('round-trips nested dates and drops undefined fields', () => {
    const value = {
      at: new Date('2026-01-01T00:00:00Z'),
      nested: [{ when: new Date(5) }],
      missing: undefined,
      plain: { $date: 1 },
    };
    const decoded = decodeDoc(encodeDoc(value));
    expect(decoded).toEqual({
      at: new Date('2026-01-01T00:00:00Z'),
      nested: [{ when: new Date(5) }],
      plain: { $date: 1 },
    });
    expect(decodeDoc(JSON.parse(encodeDoc(value)))).toEqual(decoded);
  });
});

describe('query helpers', () => {
  it('escapes LIKE wildcards in searches', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('compiles the same template per dialect', () => {
    const query = sql`SELECT * FROM runs WHERE id = ${'a'} AND late = ${0}`;
    expect(compile(query, 'postgres')).toEqual({
      text: 'SELECT * FROM runs WHERE id = $1 AND late = $2',
      params: ['a', 0],
    });
    expect(compile(query, 'sqlite').text).toBe('SELECT * FROM runs WHERE id = ? AND late = ?');
  });
});
