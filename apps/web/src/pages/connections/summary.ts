import { isRecord } from '@cloud-trigger/core';

import type { ConnectionDto } from '../../lib/api';

const ADDRESS_FIELDS = ['baseUrl', 'address', 'brokers', 'servers', 'endpoint', 'region'] as const;

export function connectionAddress(connection: Pick<ConnectionDto, 'config'>): string {
  const config = isRecord(connection.config) ? connection.config : {};
  for (const field of ADDRESS_FIELDS) {
    const value = config[field];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
    if (Array.isArray(value) && value.length > 0) {
      return value.map(String).join(', ');
    }
  }

  return '—';
}

const LOCATION_FIELDS = ['url', 'queueUrl', 'topicArn', 'topic', 'subject', 'service'] as const;

export function endpointSummary(target: { type: string; config: unknown }): string {
  const config = isRecord(target.config) ? target.config : {};
  const method = config['method'];
  const location = LOCATION_FIELDS.map((field) => config[field]).find(
    (value) => typeof value === 'string',
  );
  const where = typeof location === 'string' ? location : target.type;

  return typeof method === 'string' ? `${method} ${where}` : where;
}
