import slugify from '@sindresorhus/slugify';
import { z } from 'zod';

const KEY_LENGTH = 63;

export const slug = (what: string) =>
  z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,62}$/,
      `${what} keys use lowercase letters, digits, "-" and "_", at most 63 characters`,
    );

export const slugKey = (text: string, fallback: string): string =>
  slugify(text, { preserveCharacters: ['_'] })
    .replace(/^[-_]+/, '')
    .slice(0, KEY_LENGTH)
    .replace(/[-_]+$/, '') || fallback;
