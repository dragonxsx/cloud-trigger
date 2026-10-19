import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'ct_';

export const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex');

export const generateApiKey = (): { key: string; hash: string; prefix: string } => {
  const key = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;

  return { key, hash: hashApiKey(key), prefix: key.slice(0, 8) };
};

export const generateSessionSecret = (): string => randomBytes(48).toString('base64url');
