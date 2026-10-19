import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

export class SetupToken {
  readonly value: string;
  readonly generated: boolean;

  constructor(preset: string | undefined) {
    this.value = preset ?? randomBytes(18).toString('base64url');
    this.generated = preset === undefined;
  }

  matches(candidate: string | undefined): boolean {
    return candidate !== undefined && timingSafeEqual(digest(candidate), digest(this.value));
  }
}
