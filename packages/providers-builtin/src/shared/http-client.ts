import { Agent, type Dispatcher, interceptors } from 'undici';

const agents = new Map<number, Dispatcher>();
export const dispatcherFor = (maxRedirections: number): Dispatcher => {
  const existing = agents.get(maxRedirections);
  if (existing) {
    return existing;
  }
  const agent = new Agent().compose(interceptors.redirect({ maxRedirections }));
  agents.set(maxRedirections, agent);

  return agent;
};

export const flattenHeaders = (
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v]],
    ),
  );

export async function readLimited(body: AsyncIterable<unknown>, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    const room = limit - (size - buf.length);
    if (room > 0) {
      chunks.push(room >= buf.length ? buf : buf.subarray(0, room));
    }
    if (size > limit) {
      truncated = true;
    }
  }

  return { text: Buffer.concat(chunks).toString('utf8'), sizeBytes: size, truncated };
}

export const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
