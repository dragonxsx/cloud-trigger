import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  Result,
  type TargetResult,
  defineInlineConnectedTarget,
  failedResult,
  isRecord,
  toError,
} from '@cloud-trigger/core';
import { z } from 'zod';

import { awsConnection } from '../connection.js';
import {
  AwsConnection,
  awsFailure,
  clientCache,
  messageBody,
  resolveClientConfig,
} from '../shared.js';

export const EventBridgeTargetConfig = z.object({
  eventBusName: z.string().min(1).default('default').describe('Bus name or ARN.'),
  ...AwsConnection,
  source: z.string().min(1).describe('Event source, e.g. com.acme.billing.'),
  detailType: z.string().min(1).describe('The DetailType of the event.'),
  resources: z.array(z.string().min(1)).default([]),
});

const RETRYABLE_ENTRY_ERRORS = new Set([
  'ThrottlingException',
  'InternalFailure',
  'InternalException',
]);

const eventBridgeClient = clientCache((config) => new EventBridgeClient(config));

const parseObject = Result.fromThrowable((text: string): unknown => JSON.parse(text), toError);

export const eventBridgeTarget = defineInlineConnectedTarget({
  type: 'eventbridge',
  displayName: 'Amazon EventBridge event',
  description: 'Puts the payload on an EventBridge bus as the event detail (a JSON object).',
  configSchema: EventBridgeTargetConfig,
  connection: awsConnection,
  async execute(config, { payload, ctx, signal, connection }): Promise<TargetResult> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const clientConfig = await resolveClientConfig(connection.config, ctx.secrets);
    if (clientConfig.isErr()) {
      return failedResult('missing_secret', clientConfig.error.message, false, elapsed());
    }
    const detail = messageBody(payload, ctx);
    const parsed = parseObject(detail);
    if (parsed.isErr() || !isRecord(parsed.value)) {
      return failedResult(
        'invalid_payload',
        'EventBridge detail must be a JSON object',
        false,
        elapsed(),
      );
    }

    try {
      const sent = await eventBridgeClient(clientConfig.value).send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: config.eventBusName,
              Source: config.source,
              DetailType: config.detailType,
              Detail: detail,
              Resources: config.resources,
              Time: ctx.now,
              ...(ctx.traceparent !== undefined && { TraceHeader: ctx.traceparent }),
            },
          ],
        }),
        { abortSignal: signal },
      );
      const [entry] = sent.Entries ?? [];
      if ((sent.FailedEntryCount ?? 0) > 0 || entry?.ErrorCode !== undefined) {
        const code = entry?.ErrorCode ?? 'Unknown';

        return failedResult(
          `eventbridge_${code}`,
          entry?.ErrorMessage ?? 'Event was rejected',
          RETRYABLE_ENTRY_ERRORS.has(code),
          elapsed(),
        );
      }

      return { outcome: 'success', durationMs: elapsed(), metadata: { eventId: entry?.EventId } };
    } catch (error: unknown) {
      return awsFailure(error, signal, elapsed(), 'eventbridge');
    }
  },
});
