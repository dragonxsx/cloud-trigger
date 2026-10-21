import type { NotificationProvider, OpenNotificationParams } from '@refinedev/core';
import { useNotificationProvider } from '@refinedev/mantine';

const GENERIC_DESCRIPTIONS = new Set(['Success', 'Error']);
const INLINE_RECORD_ERROR = /-getOne-notification$/;

const REWRITES: readonly [RegExp, (match: RegExpExecArray) => string][] = [
  [
    /^There was an error creating (.+?) \(status code: \d+\)?$/,
    (m) => `Couldn't create ${lower(m[1])}`,
  ],
  [/^Error when updating (.+?) \(status code: \d+\)$/, (m) => `Couldn't save ${lower(m[1])}`],
  [/^Error when deleting (.+?) \(status code: \d+\)$/, (m) => `Couldn't delete ${lower(m[1])}`],
  [/^Error \(status code: \d+\)$/, () => "Couldn't load data"],
  [/^Successfully created (.+)$/, (m) => `Created ${lower(m[1])}`],
  [/^Successfully updated (.+)$/, (m) => `Saved ${lower(m[1])}`],
  [/^Successfully deleted (?:a )?(.+)$/, (m) => `Deleted ${lower(m[1])}`],
];

function lower(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

export function readableTitle(message: string): string {
  for (const [pattern, rewrite] of REWRITES) {
    const match = pattern.exec(message);
    if (match) {
      return rewrite(match);
    }
  }

  return message.replace(/\s*\(status code: \d+\)$/, '');
}

const reorder = (params: OpenNotificationParams): OpenNotificationParams => {
  if (params.type === 'progress') {
    return params;
  }
  const title = readableTitle(params.message);
  const body = params.description;
  if (body === undefined || body === '' || GENERIC_DESCRIPTIONS.has(body)) {
    return { ...params, message: '', description: title };
  }

  return { ...params, message: body, description: title };
};

export const useAppNotificationProvider = (): NotificationProvider => {
  const base = useNotificationProvider();

  return {
    open: (params) => {
      if (params.type === 'error' && INLINE_RECORD_ERROR.test(params.key ?? '')) {
        return;
      }
      base.open(reorder(params));
    },
    close: (key) => base.close(key),
  };
};
