import type { HttpError } from '@refinedev/core';
import { Edit, useForm } from '@refinedev/mantine';

import type { ConnectionDto } from '../../lib/api';
import {
  type ConnectionFormValues,
  ConnectionFormFields,
  blankConnection,
  toConnectionSpec,
} from './form';

export function ConnectionEdit() {
  const form = useForm<
    ConnectionDto,
    HttpError,
    ConnectionFormValues,
    ReturnType<typeof toConnectionSpec>
  >({
    initialValues: blankConnection,
    transformValues: toConnectionSpec,
    refineCoreProps: {
      resource: 'connections',
      action: 'edit',
      redirect: 'show',
      mutationMode: 'pessimistic',
    },
  });

  return (
    <Edit saveButtonProps={form.saveButtonProps}>
      <ConnectionFormFields form={form} editing />
    </Edit>
  );
}
