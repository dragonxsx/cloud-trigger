import { createHmac, timingSafeEqual } from 'node:crypto';

import { Result } from '@cloud-trigger/core';
import { z } from 'zod';

const Payload = z.object({ sub: z.string().min(1), v: z.literal(1) });
const decodeJson = Result.fromThrowable((text: string): unknown => JSON.parse(text));

export class CalendarTokens {
  constructor(private readonly secret: string | undefined) {}

  get enabled(): boolean {
    return this.secret !== undefined;
  }

  issue(subject: string): string | undefined {
    if (this.secret === undefined) {
      return undefined;
    }
    const body = Buffer.from(JSON.stringify({ sub: subject, v: 1 })).toString('base64url');

    return `${body}.${this.#sign(this.secret, body)}`;
  }

  verify(token: string): { subject: string } | undefined {
    const [body, signature] = token.split('.');
    if (this.secret === undefined || !body || !signature) {
      return undefined;
    }
    const expected = Buffer.from(this.#sign(this.secret, body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return undefined;
    }
    const parsed = decodeJson(Buffer.from(body, 'base64url').toString('utf8')).map((json) =>
      Payload.safeParse(json),
    );

    return parsed.isOk() && parsed.value.success ? { subject: parsed.value.data.sub } : undefined;
  }

  #sign(secret: string, body: string): string {
    return createHmac('sha256', secret).update(`calendar:${body}`).digest('base64url');
  }
}
