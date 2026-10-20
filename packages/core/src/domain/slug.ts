import { z } from 'zod';

export const slug = (what: string) =>
  z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,62}$/,
      `${what} keys use lowercase letters, digits, "-" and "_", at most 63 characters`,
    );
