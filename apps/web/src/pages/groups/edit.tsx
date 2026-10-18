import type { HttpError } from '@refinedev/core';
import { Edit, useForm } from '@refinedev/mantine';

import type { GroupDto } from '../../lib/api';
import { type GroupFormValues, GroupFormFields, blankGroup, toGroupSpec } from './form';

export function GroupEdit() {
  const form = useForm<GroupDto, HttpError, GroupFormValues, ReturnType<typeof toGroupSpec>>({
    initialValues: blankGroup,
    transformValues: toGroupSpec,
    refineCoreProps: {
      resource: 'groups',
      action: 'edit',
      redirect: 'show',
      mutationMode: 'pessimistic',
    },
  });

  return (
    <Edit saveButtonProps={form.saveButtonProps}>
      <GroupFormFields form={form} />
    </Edit>
  );
}
