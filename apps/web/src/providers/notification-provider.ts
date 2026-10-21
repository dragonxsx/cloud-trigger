import type { NotificationProvider, OpenNotificationParams } from '@refinedev/core';
import { useNotificationProvider } from '@refinedev/mantine';

const GENERIC_DESCRIPTIONS = new Set(['Success', 'Error']);
const INLINE_RECORD_ERROR = /-getOne-notification$/;

const reorder = (params: OpenNotificationParams): OpenNotificationParams => {
  if (params.type === 'progress') {
    return params;
  }
  const title = params.message;
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
