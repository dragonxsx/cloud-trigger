import { isRecord } from '@cloud-trigger/core';

import type { ConnectionDto } from '../../lib/api';

const ADDRESS_FIELDS = [
  'baseUrl',
  'host',
  'address',
  'brokers',
  'servers',
  'endpoint',
  'region',
] as const;

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

const LOCATION_FIELDS = [
  'url',
  'queueUrl',
  'topicArn',
  'topic',
  'topics',
  'to',
  'channel',
  'subject',
  'stream',
  'service',
] as const;

export function endpointSummary(target: { type: string; config: unknown }): string {
  const config = isRecord(target.config) ? target.config : {};
  const method = config['method'];
  const location = LOCATION_FIELDS.map((field) => config[field])
    .map((value) => (Array.isArray(value) ? value.map(String).join(', ') : value))
    .find((value) => typeof value === 'string');
  const where = typeof location === 'string' ? location : target.type;

  return typeof method === 'string' ? `${method} ${where}` : where;
}

export const hasValue = (value: unknown): boolean => {
  if (value === undefined || value === '') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.values(value).some(hasValue);
  }

  return true;
};

export const countValues = (value: unknown): number => {
  if (isRecord(value)) {
    return Object.values(value).reduce<number>((total, child) => total + countValues(child), 0);
  }

  return hasValue(value) ? 1 : 0;
};

export const fieldCount = (count: number): string =>
  `${String(count)} field${count === 1 ? '' : 's'}`;

export type TestTone = 'ok' | 'warn' | 'fail';

export interface TestView {
  readonly tone: TestTone;
  readonly message: string;
}

const NETWORK_REASONS: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'DNS lookup failed',
  ETIMEDOUT: 'timed out',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  UND_ERR_CONNECT_TIMEOUT: 'timed out',
  UND_ERR_HEADERS_TIMEOUT: 'no response in time',
  UND_ERR_SOCKET: 'connection closed',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed TLS certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate not trusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the host',
  network_error: 'network error',
};

const hostOf = (address: string): string => {
  if (address === '—' || address === '') {
    return 'the server';
  }
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
};

export function describeTest(result: { ok: boolean; message: string }, address: string): TestView {
  const status = /answered HTTP (\d{3})$/.exec(result.message)?.[1];
  if (result.ok) {
    return status !== undefined && Number(status) >= 300
      ? { tone: 'warn', message: `Reachable, but ${result.message}` }
      : { tone: 'ok', message: result.message };
  }
  const network = /^([A-Za-z_]+):\s*(.*)$/.exec(result.message);
  const code = network?.[1];
  const detail = network?.[2]?.trim() ?? '';
  const reason =
    code === undefined
      ? undefined
      : (NETWORK_REASONS[code] ??
        (/^(E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(code) ? detail || code : undefined));
  if (reason !== undefined) {
    return { tone: 'fail', message: `Could not connect to ${hostOf(address)} (${reason})` };
  }

  return { tone: 'fail', message: result.message };
}
