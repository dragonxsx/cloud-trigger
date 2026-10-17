import { err, ok } from 'neverthrow';

import type { SecretResolver } from '../ports/secrets.js';

const PLACEHOLDER = /\{\{\s*secret:([A-Za-z0-9_.-]+)\s*\}\}/g;

export function createSecretResolver(
  lookup: (name: string) => Promise<string | undefined>,
): SecretResolver {
  return {
    get: lookup,
    async interpolate(text) {
      const names = [...new Set(Array.from(text.matchAll(PLACEHOLDER), (m) => m[1] ?? ''))];
      if (names.length === 0) {
        return ok(text);
      }
      const values = new Map<string, string>();
      const missing: string[] = [];
      for (const name of names) {
        const value = await lookup(name);
        if (value === undefined) {
          missing.push(name);
        } else {
          values.set(name, value);
        }
      }
      if (missing.length > 0) {
        return err({
          code: 'missing_secret',
          message: `Missing secrets: ${missing.join(', ')}`,
          names: missing,
        });
      }

      return ok(text.replace(PLACEHOLDER, (_match, name: string) => values.get(name) ?? ''));
    },
  };
}

export const mapSecretResolver = (secrets: Readonly<Record<string, string>>): SecretResolver =>
  createSecretResolver(async (name) => secrets[name]);
