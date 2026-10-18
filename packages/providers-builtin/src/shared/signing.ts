import { createHmac } from 'node:crypto';

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

export function signatureHeaders(
  config: Pick<SigningConfig, 'header' | 'timestampHeader'>,
  p: { secret: string; body: string | undefined; now: Date },
): Record<string, string> {
  const timestamp = String(Math.floor(p.now.getTime() / 1000));
  const signature = createHmac('sha256', p.secret)
    .update(`${timestamp}.${p.body ?? ''}`)
    .digest('hex');

  return { [config.header]: `sha256=${signature}`, [config.timestampHeader]: timestamp };
}
