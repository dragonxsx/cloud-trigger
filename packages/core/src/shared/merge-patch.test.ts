import { describe, expect, it } from 'vitest';

import { mergePatch } from './merge-patch.js';

describe('mergePatch', () => {
  it('follows RFC 7386', () => {
    expect(
      mergePatch(
        { method: 'POST', url: '/charges', headers: { a: '1', b: '2' }, query: { x: '1' } },
        { headers: { b: '3', c: '4' }, query: null, retries: [1] },
      ),
    ).toEqual({
      method: 'POST',
      url: '/charges',
      headers: { a: '1', b: '3', c: '4' },
      retries: [1],
    });
  });

  it('replaces arrays and scalars, and a non-object patch replaces the target', () => {
    expect(mergePatch({ list: [1, 2] }, { list: [3] })).toEqual({ list: [3] });
    expect(mergePatch({ a: 1 }, 'x')).toBe('x');
    expect(mergePatch('x', { a: { b: null, c: 1 } })).toEqual({ a: { c: 1 } });
  });
});
