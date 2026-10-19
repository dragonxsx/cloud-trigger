import type { HttpError } from '@refinedev/core';
import { Create, useForm } from '@refinedev/mantine';

import type { ConnectionDto } from '../../lib/api';
import {
  type ConnectionFormValues,
  ConnectionFormFields,
  blankConnection,
  toConnectionSpec,
} from './form';

export function ConnectionCreate() {
  const form = useForm<
    ConnectionDto,
    HttpError,
    ConnectionFormValues,
    ReturnType<typeof toConnectionSpec>
  >({
    initialValues: blankConnection,
    transformValues: toConnectionSpec,
    refineCoreProps: { resource: 'connections', action: 'create', redirect: 'show' },
  });

  return (
    <Create title="New connection" saveButtonProps={form.saveButtonProps}>
      <ConnectionFormFields form={form} />
    </Create>
  );
}
