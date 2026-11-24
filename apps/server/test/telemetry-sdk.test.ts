import { afterEach, describe, expect, it, vi } from 'vitest';

import { isQuietPath } from '../src/common/quiet-paths.js';
import { TelemetryShape } from '../src/config/telemetry-config.js';
import { carriesTraceparent, serviceResource } from '../src/infra/telemetry/sdk.js';

describe('carriesTraceparent', () => {
  it('finds a traceparent the target already set, in every undici header shape', () => {
    expect(carriesTraceparent(['accept', '*/*', 'Traceparent', '00-abc-def-01'])).toBe(true);
    expect(carriesTraceparent('host: x\r\ntraceparent: 00-abc-def-01\r\n')).toBe(true);
  });

  it('ignores header values and other headers', () => {
    expect(carriesTraceparent(['x-note', 'traceparent', 'accept', '*/*'])).toBe(false);
    expect(carriesTraceparent('host: x\r\nx-traceparent-copy: y\r\n')).toBe(false);
  });
});

describe('isQuietPath', () => {
  it('matches health and metrics paths only', () => {
    expect(['/health/live', '/health/ready', '/metrics', '/metrics?x=1'].map(isQuietPath)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['/healthz', '/api/metrics', '/', undefined].map(isQuietPath)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

const serviceName = (env: Record<string, string>) => {
  vi.stubEnv('OTEL_SERVICE_NAME', env['OTEL_SERVICE_NAME'] ?? '');
  vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', env['OTEL_RESOURCE_ATTRIBUTES'] ?? '');

  return serviceResource(TelemetryShape.parse({ ...env, INSTANCE_ID: 'i-1' })).attributes;
};

describe('serviceResource', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names the service cloud-trigger by default', () => {
    expect(serviceName({})).toMatchObject({
      'service.name': 'cloud-trigger',
      'service.instance.id': 'i-1',
    });
  });

  it('keeps service.name from OTEL_RESOURCE_ATTRIBUTES', () => {
    expect(
      serviceName({ OTEL_RESOURCE_ATTRIBUTES: 'service.name=scheduler-prod' })['service.name'],
    ).toBe('scheduler-prod');
  });

  it('prefers OTEL_SERVICE_NAME over the resource attributes', () => {
    expect(
      serviceName({
        OTEL_SERVICE_NAME: 'explicit',
        OTEL_RESOURCE_ATTRIBUTES: 'service.name=scheduler-prod',
      })['service.name'],
    ).toBe('explicit');
  });
});
