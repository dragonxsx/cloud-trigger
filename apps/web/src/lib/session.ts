import { z } from 'zod';

import { bestEffortStorage } from './storage';

const SESSION_KEY = 'cloud-trigger.session';
const SETUP_TOKEN_KEY = 'cloud-trigger.setup-token';

const StoredSession = z.object({ token: z.string().min(1), expiresAt: z.iso.datetime() });
export type StoredSession = z.output<typeof StoredSession>;

const parseJson = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);

    return parsed;
  } catch {
    return undefined;
  }
};

export const passwordSession = {
  current(now = Date.now()): string | null {
    const raw = bestEffortStorage.get(SESSION_KEY);
    const parsed = raw === null ? undefined : StoredSession.safeParse(parseJson(raw));
    if (!parsed?.success || Date.parse(parsed.data.expiresAt) <= now) {
      return null;
    }

    return parsed.data.token;
  },
  set(session: StoredSession | null): void {
    bestEffortStorage.set(SESSION_KEY, session === null ? null : JSON.stringify(session));
  },
};

export const setupToken = {
  get(): string | null {
    try {
      return window.sessionStorage.getItem(SETUP_TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null): void {
    try {
      if (token === null) {
        window.sessionStorage.removeItem(SETUP_TOKEN_KEY);
      } else {
        window.sessionStorage.setItem(SETUP_TOKEN_KEY, token);
      }
    } catch {
      return;
    }
  },
};
