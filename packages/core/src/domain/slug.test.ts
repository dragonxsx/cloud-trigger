import { describe, expect, it } from 'vitest';

import { slug, slugKey } from './slug.js';

describe('slugKey', () => {
  it.each([
    ['Đà Nẵng API', 'da-nang-api'],
    ['Café sync', 'cafe-sync'],
    ['Straße', 'strasse'],
    ['Привет', 'privet'],
    ['fooBar baz', 'foo-bar-baz'],
    ['api.example.com', 'api-example-com'],
    ['__private_key__', 'private_key'],
    ['GET /users/{id}', 'get-users-id'],
  ])('turns %j into %j', (text, key) => {
    expect(slugKey(text, 'fallback')).toBe(key);
  });

  it('falls back when nothing usable remains', () => {
    expect(slugKey('!!! ???', 'fallback')).toBe('fallback');
  });

  it('truncates to a valid key without a trailing separator', () => {
    const key = slugKey(`${'a'.repeat(62)} b`, 'fallback');

    expect(key).toBe('a'.repeat(62));
    expect(slug('Test').safeParse(slugKey('word '.repeat(20), 'fallback')).success).toBe(true);
  });
});
