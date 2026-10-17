import type { ProviderPlugin, ProviderRegistry } from '@cloud-trigger/core';
import { z } from 'zod';

const Plugin = z.object({
  name: z.string(),
  register: z.custom<ProviderPlugin['register']>((value) => typeof value === 'function'),
});
const PluginModule = z.looseObject({ default: Plugin.optional(), plugin: Plugin.optional() });

export async function loadPlugins(
  registry: ProviderRegistry,
  specifiers: readonly string[],
): Promise<string[]> {
  const loaded: string[] = [];
  for (const specifier of specifiers) {
    const mod = PluginModule.safeParse(await import(specifier));
    const plugin = mod.success ? (mod.data.default ?? mod.data.plugin) : undefined;
    if (!plugin) {
      throw new Error(`Module "${specifier}" does not export a provider plugin`);
    }
    registry.use(plugin);
    loaded.push(plugin.name);
  }

  return loaded;
}
