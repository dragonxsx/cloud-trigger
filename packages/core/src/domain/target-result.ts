import { z } from 'zod';

export const TargetError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type TargetError = z.output<typeof TargetError>;

export const TargetResponse = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  sizeBytes: z.int().min(0),
  truncated: z.boolean(),
});
export type TargetResponse = z.output<typeof TargetResponse>;

export const TargetResult = z.object({
  outcome: z.enum(['success', 'failure']),
  durationMs: z.number().min(0),
  statusCode: z.int().optional(),
  response: TargetResponse.optional(),
  error: TargetError.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type TargetResult = z.output<typeof TargetResult>;

export const FanoutChild = z.object({
  index: z.int().min(0),
  type: z.string(),
  name: z.string().optional(),
  outcome: z.enum(['success', 'failure']),
  durationMs: z.number(),
  statusCode: z.int().optional(),
  error: TargetError.optional(),
});
export type FanoutChild = z.output<typeof FanoutChild>;

export const FanoutMetadata = z.object({
  mode: z.enum(['all', 'any']),
  children: z.array(FanoutChild),
});
export type FanoutMetadata = z.output<typeof FanoutMetadata>;

export const EngineErrorCode = {
  timeout: 'timeout',
  cancelled: 'cancelled',
  leaseLost: 'lease_lost',
  inputFailed: 'input_failed',
  configInvalid: 'invalid_config',
  unexpected: 'unexpected',
} as const;

export const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export const failedResult = (
  code: string,
  message: string,
  retryable: boolean,
  durationMs = 0,
): TargetResult => ({ outcome: 'failure', durationMs, error: { code, message, retryable } });

export const abortedResult = (signal: AbortSignal, durationMs: number): TargetResult => {
  const reason: unknown = signal.reason;
  if (reason instanceof DOMException && reason.name === 'TimeoutError') {
    return failedResult(EngineErrorCode.timeout, 'Run exceeded its timeout', true, durationMs);
  }
  const message = reason instanceof Error ? reason.message : 'Cancelled';

  return failedResult(EngineErrorCode.cancelled, message, false, durationMs);
};

export async function abortable<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  work.catch(() => undefined);
  if (signal.aborted) {
    throw toError(signal.reason);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(toError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
