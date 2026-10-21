import { mapSecretResolver } from '@cloud-trigger/core';
import { contractRunContext, describeTargetContract } from '@cloud-trigger/testing';
import {
  Server,
  type ServerUnaryCall,
  type ServiceDefinition,
  ServerCredentials,
  type sendUnaryData,
  status,
} from '@grpc/grpc-js';
import type { PackageDefinition } from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseInlineProto } from './definitions.js';
import { grpcConnection, grpcTarget } from './grpc-target.js';

const PROTO = `
syntax = "proto3";
package test.v1;
import "google/protobuf/timestamp.proto";

service Echo {
  rpc Say(SayRequest) returns (SayReply);
  rpc Slow(SayRequest) returns (SayReply);
  rpc Unavailable(SayRequest) returns (SayReply);
  rpc Invalid(SayRequest) returns (SayReply);
}
message SayRequest {
  string text = 1;
  int64 count = 2;
  google.protobuf.Timestamp at = 3;
}
message SayReply {
  string text = 1;
  string traceparent = 2;
  string auth = 3;
  int64 count = 4;
}
`;

const SayRequest = z.object({ text: z.string().default(''), count: z.string().default('0') });

let server: Server | undefined;
let address = '';
const seenTraceparents: string[] = [];

const metadataValue = (call: ServerUnaryCall<unknown, unknown>, key: string): string => {
  const [value] = call.metadata.get(key);

  return typeof value === 'string' ? value : '';
};

const handlers = {
  Say: (call: ServerUnaryCall<unknown, unknown>, callback: sendUnaryData<unknown>) => {
    const request = SayRequest.parse(call.request);
    const traceparent = metadataValue(call, 'traceparent');
    seenTraceparents.push(traceparent);
    callback(null, {
      text: `echo:${request.text}`,
      traceparent,
      auth: metadataValue(call, 'authorization'),
      count: request.count,
    });
  },
  Slow: (_call: ServerUnaryCall<unknown, unknown>, callback: sendUnaryData<unknown>) => {
    const timer = setTimeout(() => callback(null, { text: 'late' }), 2_000);
    timer.unref();
  },
  Unavailable: (_call: ServerUnaryCall<unknown, unknown>, callback: sendUnaryData<unknown>) => {
    callback({ code: status.UNAVAILABLE, details: 'down for maintenance' });
  },
  Invalid: (_call: ServerUnaryCall<unknown, unknown>, callback: sendUnaryData<unknown>) => {
    callback({ code: status.INVALID_ARGUMENT, details: 'bad text' });
  },
};

const echoService = (definition: PackageDefinition): ServiceDefinition => {
  const service = definition['test.v1.Echo'];
  if (service === undefined || 'format' in service) {
    throw new Error('Echo service missing from the test proto');
  }

  return service;
};

async function startServer(): Promise<void> {
  const definition = parseInlineProto(PROTO);
  const grpcServer = new Server();
  grpcServer.addService(echoService(definition), handlers);
  new ReflectionService(definition).addToServer(grpcServer);
  const port = await new Promise<number>((resolve, reject) => {
    grpcServer.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) => {
      if (error) {
        reject(error);
      } else {
        resolve(bound);
      }
    });
  });
  server = grpcServer;
  address = `127.0.0.1:${port}`;
}

const stopServer = () => {
  server?.forceShutdown();

  return Promise.resolve();
};

const inline = (method: string, extra: Record<string, unknown> = {}) => ({
  address,
  service: 'test.v1.Echo',
  method,
  protoSource: { type: 'inline', proto: PROTO },
  ...extra,
});

describeTargetContract(grpcTarget, {
  setup: startServer,
  teardown: stopServer,
  succeeding: () => inline('Say', { secretMetadata: { authorization: 'Bearer x' } }),
  slow: () => inline('Slow'),
  retryableFailure: () => inline('Unavailable'),
  terminalFailure: () => inline('Invalid'),
  invalid: { address: '', service: 'x', method: 'y' },
  secretPaths: [['secretMetadata', 'authorization']],
  lastTraceparent: () => Promise.resolve(seenTraceparents.at(-1)),
});

const overConnection = (method: string, extra: Record<string, unknown> = {}) => ({
  service: 'test.v1.Echo',
  method,
  protoSource: { type: 'inline', proto: PROTO },
  ...extra,
});

describeTargetContract(grpcTarget, {
  setup: startServer,
  teardown: stopServer,
  connection: () => ({
    key: 'echo',
    version: 1,
    config: { address, metadata: { authorization: 'Bearer base' } },
  }),
  succeeding: () => overConnection('Say', { secretMetadata: { 'x-token': 't' } }),
  slow: () => overConnection('Slow'),
  retryableFailure: () => overConnection('Unavailable'),
  terminalFailure: () => overConnection('Invalid'),
  invalid: overConnection('Say', { address: '127.0.0.1:1' }),
  secretPaths: [['secretMetadata', 'x-token']],
  lastTraceparent: () => Promise.resolve(seenTraceparents.at(-1)),
});

const call = async (config: Record<string, unknown>, body = '{"text":"hi","count":"42"}') => {
  const bound = grpcTarget.bind(config);
  if (bound.isErr()) {
    throw new Error(bound.error.message);
  }

  return bound.value.execute({
    payload: { body, contentType: 'application/json', attributes: {} },
    ctx: contractRunContext({ TOKEN: 's3cr3t' }),
    signal: AbortSignal.timeout(5_000),
  });
};

describe('grpc target', () => {
  beforeAll(startServer);
  afterAll(stopServer);

  it('converts JSON to protobuf and back, with secret metadata', async () => {
    const result = await call(
      inline('Say', { metadata: { authorization: 'Bearer {{secret:TOKEN}}' } }),
    );
    expect(result.outcome).toBe('success');
    expect(result.statusCode).toBe(0);
    expect(JSON.parse(result.response?.body ?? '{}')).toMatchObject({
      text: 'echo:hi',
      auth: 'Bearer s3cr3t',
      count: '42',
    });
  });

  it('extracts the channel onto a connection and answers the same', async () => {
    const config = inline('Say', {
      metadata: { 'x-team': 'billing' },
      secretMetadata: { authorization: 'Bearer {{secret:TOKEN}}' },
    });
    const split = grpcTarget.extractConnection?.(config, {})._unsafeUnwrap();
    expect(split?.connection).toEqual({
      address,
      secretMetadata: { authorization: 'Bearer {{secret:TOKEN}}' },
    });
    expect(split?.config).not.toHaveProperty('address');
    const connected = grpcTarget
      .bind(split?.config, { connection: { key: 'echo', version: 1, config: split?.connection } })
      ._unsafeUnwrap()
      .execute({
        payload: {
          body: '{"text":"hi","count":"42"}',
          contentType: 'application/json',
          attributes: {},
        },
        ctx: contractRunContext({ TOKEN: 's3cr3t' }),
        signal: AbortSignal.timeout(5_000),
      });
    const [before, after] = await Promise.all([call(config), connected]);
    expect(after.response?.body).toBe(before.response?.body);
    expect(grpcTarget.extractConnection?.(config, { baseUrl: 'https://x' }).isErr()).toBe(true);
  });

  it('tests a connection by waiting for the channel', async () => {
    const ctx = {
      secrets: mapSecretResolver({}),
      signal: AbortSignal.timeout(15_000),
      now: new Date(),
    };
    const ready = await grpcConnection.bind({ address })._unsafeUnwrap().test(ctx);
    expect(ready._unsafeUnwrap().message).toMatch(/Connected/);
    const missing = grpcTarget.bind({ service: 'test.v1.Echo', method: 'Say' });
    expect(missing.isErr() && missing.error.issues.map((i) => i.path)).toEqual(['address']);
  });

  it('loads the schema through server reflection', async () => {
    const result = await call({ address, service: 'test.v1.Echo', method: 'Say' });
    expect(result.outcome).toBe('success');
    expect(result.metadata).toMatchObject({ grpcStatus: 'OK' });
  });

  it('checks a JSONPath assertion against the response', async () => {
    const passing = await call(
      inline('Say', { assertions: { jsonPath: { path: '$.text', equals: 'echo:hi' } } }),
    );
    expect(passing.outcome).toBe('success');
    const failing = await call(
      inline('Say', { assertions: { jsonPath: { path: '$.text', equals: 'nope' } } }),
    );
    expect(failing.error).toMatchObject({ code: 'grpc_assertion', retryable: false });
  });

  it('accepts expected non-OK codes', async () => {
    const result = await call(
      inline('Invalid', { assertions: { expectedCodes: ['INVALID_ARGUMENT'] } }),
    );
    expect(result.outcome).toBe('success');
  });

  it('maps DEADLINE_EXCEEDED to a retryable failure', async () => {
    const result = await call(inline('Slow', { deadlineMs: 100 }));
    expect(result.error).toMatchObject({ code: 'grpc_deadline_exceeded', retryable: true });
  });

  it('rejects unknown methods and non-object requests without retrying', async () => {
    const missing = await call(inline('Nope'));
    expect(missing.error).toMatchObject({ code: 'grpc_method_not_found', retryable: false });
    const badBody = await call(inline('Say'), '[1,2]');
    expect(badBody.error).toMatchObject({ code: 'invalid_request', retryable: false });
  });
});
