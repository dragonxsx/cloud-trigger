import { Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import type { ReactNode } from 'react';

export interface ConfirmOptions {
  readonly title: string;
  readonly message: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
}

export interface ConfirmActionOptions extends ConfirmOptions {
  readonly onConfirm: () => unknown;
}

export const confirmed = ({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = true,
}: ConfirmOptions): Promise<boolean> =>
  new Promise((resolve) => {
    openConfirmModal({
      title,
      centered: true,
      children: typeof message === 'string' ? <Text size="sm">{message}</Text> : message,
      labels: { confirm: confirmLabel, cancel: cancelLabel },
      confirmProps: { color: danger ? 'red' : 'signal' },
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
      onClose: () => resolve(false),
    });
  });

export async function confirmAction({
  onConfirm,
  ...options
}: ConfirmActionOptions): Promise<void> {
  if (await confirmed(options)) {
    await onConfirm();
  }
}
