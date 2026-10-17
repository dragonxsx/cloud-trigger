import { describe, expect, it } from 'vitest';

import { testContext } from '../test-helpers.js';
import { staticInput } from './static.js';
import { templateInput } from './template.js';

describe('inputs', () => {
  it('static json / none', async () => {
    const json = await staticInput
      .bind({ format: 'json', value: { a: 1 } })
      ._unsafeUnwrap()
      .resolve(testContext());
    expect(json).toMatchObject({ body: '{"a":1}', contentType: 'application/json' });
    const none = await staticInput.bind({ format: 'none' })._unsafeUnwrap().resolve(testContext());
    expect(none.body).toBeUndefined();
  });

  it('template renders run metadata and secrets', async () => {
    const input = templateInput
      .bind({
        template: '{"id":"{{ run.id }}","attempt":{{ run.attempt }}}',
        attributes: { authorization: 'Bearer {{ "TOKEN" | secret }}' },
      })
      ._unsafeUnwrap();
    const payload = await input.resolve(testContext({ attempt: 2 }));
    expect(payload.body).toBe('{"id":"run-1","attempt":2}');
    expect(payload.attributes).toEqual({ authorization: 'Bearer s3cr3t' });
  });

  it('template rejects invalid syntax at bind time', () => {
    expect(templateInput.bind({ template: '{% if %}' }).isErr()).toBe(true);
  });
});
