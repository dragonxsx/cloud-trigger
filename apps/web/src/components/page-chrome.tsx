import { Title } from '@mantine/core';
import { Breadcrumb } from '@refinedev/mantine';
import { IconArrowLeft } from '@tabler/icons-react';
import type { PointerEvent, ReactNode } from 'react';

import { focusFirstInvalidField } from '../lib/errors';

export const backIcon = (
  <>
    <IconArrowLeft size={18} aria-hidden />
    <span className="ct-sr-only">Back</span>
  </>
);

export const countOf = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

export const pageBreadcrumb = <Breadcrumb showHome={false} />;

export function PageHeading({ children }: { children: ReactNode }) {
  return (
    <Title order={1} size="h3" sx={{ overflowWrap: 'anywhere' }}>
      {children}
    </Title>
  );
}

export const saveWithInvalidFocus = (form: {
  readonly validate: () => { hasErrors: boolean };
  readonly saveButtonProps: {
    disabled: boolean;
    onClick: (event: PointerEvent<HTMLButtonElement>) => void;
  };
}) => ({
  ...form.saveButtonProps,
  onClick: (event: PointerEvent<HTMLButtonElement>) => {
    if (form.validate().hasErrors) {
      focusFirstInvalidField();
    } else {
      form.saveButtonProps.onClick(event);
    }
  },
});
