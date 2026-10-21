import type { I18nProvider } from '@refinedev/core';
import { z } from 'zod';

const ResourceOptions = z.object({ resource: z.string() });

const MESSAGES: Readonly<Record<string, (resource: string) => string>> = {
  'actions.create': () => 'Create',
  'actions.edit': () => 'Edit',
  'actions.show': () => 'Show',
  'actions.clone': () => 'Clone',
  'notifications.createSuccess': (resource) => `Created ${resource}`,
  'notifications.editSuccess': (resource) => `Saved ${resource}`,
  'notifications.deleteSuccess': (resource) => `Deleted ${resource}`,
  'notifications.createError': (resource) => `Couldn't create ${resource}`,
  'notifications.editError': (resource) => `Couldn't save ${resource}`,
  'notifications.deleteError': (resource) => `Couldn't delete ${resource}`,
  'notifications.error': () => "Couldn't load data",
  'notifications.success': () => '',
};

export const i18nProvider: I18nProvider = {
  translate: (key: string, options?: unknown, defaultMessage?: string): string => {
    const message = MESSAGES[key];
    if (message) {
      const parsed = ResourceOptions.safeParse(options);

      return message(parsed.success ? parsed.data.resource.toLowerCase() : 'item');
    }

    return defaultMessage ?? (typeof options === 'string' ? options : key);
  },
  changeLocale: () => Promise.resolve(),
  getLocale: () => 'en',
};
