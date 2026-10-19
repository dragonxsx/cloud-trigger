import { type AuthSettings, type User, UserId } from '@cloud-trigger/core';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

export const LOCAL_ISSUER = 'cloud-trigger';
const AUDIENCE = 'cloud-trigger:session';

const Claims = z.object({ sub: UserId, ver: z.int().min(0) });
export type SessionClaims = z.output<typeof Claims>;

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

const keyOf = (settings: AuthSettings) => new TextEncoder().encode(settings.sessionSecret);

export async function issueSession(
  user: User,
  settings: AuthSettings,
  now: Date,
): Promise<IssuedSession> {
  const expiresAt = new Date(now.getTime() + settings.local.sessionTtlMinutes * 60_000);
  const token = await new SignJWT({ ver: user.tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(LOCAL_ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(user.id)
    .setIssuedAt(Math.floor(now.getTime() / 1_000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
    .sign(keyOf(settings));

  return { token, expiresAt };
}

export async function verifySession(
  token: string,
  settings: AuthSettings,
  now: Date,
): Promise<SessionClaims | undefined> {
  try {
    const { payload } = await jwtVerify(token, keyOf(settings), {
      issuer: LOCAL_ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      currentDate: now,
    });
    const claims = Claims.safeParse(payload);

    return claims.success ? claims.data : undefined;
  } catch {
    return undefined;
  }
}
