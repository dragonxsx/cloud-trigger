import { err, ok, type Result } from 'neverthrow';

import type { UnknownProviderError } from '../shared/errors.js';
import { type AnyProvider, type JsonSchema, type Provider, ProviderKind } from './sdk.js';

export interface ProviderInfo {
  readonly kind: ProviderKind;
  readonly type: string;
  readonly displayName: string;
  readonly description: string;
  readonly configSchema: JsonSchema;
}

export interface ProviderPlugin {
  readonly name: string;
  register(registry: ProviderRegistry): void;
}

export class ProviderRegistry {
  readonly #providers: { [K in ProviderKind]: Map<string, Provider<K>> } = {
    trigger: new Map(),
    input: new Map(),
    target: new Map(),
    notifier: new Map(),
  };

  register(...providers: readonly AnyProvider[]): this {
    for (const provider of providers) {
      switch (provider.kind) {
        case 'trigger':
          this.#add(this.#providers.trigger, provider);
          break;
        case 'input':
          this.#add(this.#providers.input, provider);
          break;
        case 'target':
          this.#add(this.#providers.target, provider);
          break;
        case 'notifier':
          this.#add(this.#providers.notifier, provider);
          break;
      }
    }

    return this;
  }

  use(...plugins: readonly ProviderPlugin[]): this {
    for (const plugin of plugins) {
      plugin.register(this);
    }

    return this;
  }

  get<K extends ProviderKind>(kind: K, type: string): Result<Provider<K>, UnknownProviderError> {
    const map: Map<string, Provider<K>> = this.#providers[kind];
    const provider = map.get(type);

    return provider
      ? ok(provider)
      : err({
          code: 'unknown_provider',
          message: `No ${kind} provider registered for type "${type}"`,
        });
  }

  list(kind?: ProviderKind): ProviderInfo[] {
    const kinds: readonly ProviderKind[] = kind ? [kind] : ProviderKind.options;

    return kinds.flatMap((k) =>
      [...this.#providers[k].values()].map((p) => ({
        kind: p.kind,
        type: p.type,
        displayName: p.displayName,
        description: p.description,
        configSchema: p.jsonSchema(),
      })),
    );
  }

  #add<K extends ProviderKind>(map: Map<string, Provider<K>>, provider: Provider<K>): void {
    if (map.has(provider.type)) {
      throw new Error(`Duplicate ${provider.kind} provider "${provider.type}"`);
    }
    map.set(provider.type, provider);
  }
}
