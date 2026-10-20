import { type LookupAddress, lookup } from 'node:dns';
import type { LookupFunction } from 'node:net';

import { type ConfigError, type Result, err, ok } from '@cloud-trigger/core';
import ipaddr from 'ipaddr.js';
import { Agent, errors, request } from 'undici';

import { token } from '../../common/tokens.js';

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchedSpec {
  readonly text: string;
  readonly finalUrl: string;
}

export interface SpecFetcher {
  readonly fetchText: (
    url: string,
    signal: AbortSignal,
  ) => Promise<Result<FetchedSpec, ConfigError>>;
}

export interface SpecFetcherOptions {
  readonly allowPrivate: boolean;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export const isPublicAddress = (address: string): boolean =>
  ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';

class BlockedAddress extends Error {}
class UnsupportedScheme extends Error {}

const failure = (message: string): ConfigError => ({
  code: 'invalid_config',
  message: 'The OpenAPI document could not be fetched',
  issues: [{ path: 'source.url', message }],
});

const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, found: LookupAddress[] | undefined) => {
    const addresses = error === null ? (found ?? []) : [];
    const [first] = addresses;
    if (error !== null || first === undefined) {
      callback(error ?? new Error(`No address for ${hostname}`), '', 0);

      return;
    }
    if (addresses.some((entry) => !isPublicAddress(entry.address))) {
      callback(new BlockedAddress(hostname), '', 0);

      return;
    }
    if (options.all === true) {
      callback(null, addresses);
    } else {
      callback(null, first.address, first.family);
    }
  });
};

const literalHost = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');

const describeError = (error: unknown, maxBytes: number): string => {
  if (error instanceof BlockedAddress) {
    return 'The host resolves to a private or internal address';
  }
  if (error instanceof UnsupportedScheme) {
    return 'Only http and https URLs are supported';
  }
  if (error instanceof errors.ResponseExceededMaxSizeError) {
    return `The document is larger than ${maxBytes} bytes`;
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'The host did not answer in time';
  }

  return 'The host could not be reached';
};

export interface ClosableSpecFetcher extends SpecFetcher {
  readonly close: () => Promise<void>;
}

export const SPEC_FETCHER = token<ClosableSpecFetcher>('SPEC_FETCHER');

export function createSpecFetcher(options: SpecFetcherOptions): ClosableSpecFetcher {
  const agent = new Agent({
    maxResponseSize: options.maxBytes,
    ...(!options.allowPrivate && { connect: { lookup: publicOnlyLookup } }),
  });

  const fetchOnce = async (url: URL, signal: AbortSignal) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UnsupportedScheme(url.protocol);
    }
    const host = literalHost(url);
    if (!options.allowPrivate && ipaddr.isValid(host) && !isPublicAddress(host)) {
      throw new BlockedAddress(host);
    }

    return request(url, {
      method: 'GET',
      headers: {
        accept: 'application/json, application/yaml, text/yaml, */*',
        'user-agent': 'cloud-trigger',
      },
      signal,
      dispatcher: agent,
    });
  };

  return {
    close: () => agent.close(),
    fetchText: async (raw, outer) => {
      const signal = AbortSignal.any([outer, AbortSignal.timeout(options.timeoutMs)]);
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return err(failure('Not a valid URL'));
      }
      try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          const response = await fetchOnce(url, signal);
          const location = response.headers['location'];
          if (REDIRECT_STATUSES.has(response.statusCode) && typeof location === 'string') {
            await response.body.dump();
            url = new URL(location, url);
            continue;
          }
          if (response.statusCode >= 400) {
            await response.body.dump();

            return err(failure(`The host answered HTTP ${response.statusCode}`));
          }

          return ok({ text: await response.body.text(), finalUrl: url.toString() });
        }

        return err(failure(`More than ${MAX_REDIRECTS} redirects`));
      } catch (error: unknown) {
        return err(failure(describeError(error, options.maxBytes)));
      }
    },
  };
}
