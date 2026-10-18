import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { secret } from '@cloud-trigger/core';
import { z } from 'zod';

export const SigningConfig = z
  .object({
    secret: secret(z.string().min(1)),
    header: z.string().default('X-Signature'),
    timestampHeader: z.string().default('X-Signature-Timestamp'),
  })
  .describe('HMAC-SHA256 over "<timestamp>.<body>".');
export type SigningConfig = z.output<typeof SigningConfig>;

const sign = (key: string, timestamp: string, body: string | undefined) =>
  createHmac('sha256', key)
    .update(`${timestamp}.${body ?? ''}`)
    .digest('hex');

const digest = (value: string) => createHash('sha256').update(value).digest();

export const constantTimeEquals = (a: string, b: string): boolean =>
  timingSafeEqual(digest(a), digest(b));

export function verifySignature(p: {
  secret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  now: Date;
  toleranceSeconds: number;
}): boolean {
  if (p.signature === undefined || p.timestamp === undefined || !/^\d+$/.test(p.timestamp)) {
    return false;
  }
  const skew = Math.abs(p.now.getTime() / 1000 - Number(p.timestamp));

  return (
    skew <= p.toleranceSeconds &&
    constantTimeEquals(p.signature, `sha256=${sign(p.secret, p.timestamp, p.body)}`)
  );
}

export function signatureHeaders(
  config: Pick<SigningConfig, 'header' | 'timestampHeader'>,
  p: { secret: string; body: string | undefined; now: Date },
): Record<string, string> {
  const timestamp = String(Math.floor(p.now.getTime() / 1000));

  return {
    [config.header]: `sha256=${sign(p.secret, timestamp, p.body)}`,
    [config.timestampHeader]: timestamp,
  };
}
