import type { HttpError } from '@refinedev/core';
import { Create, useForm } from '@refinedev/mantine';

import type { GroupDto } from '../../lib/api';
import { type GroupFormValues, GroupFormFields, blankGroup, toGroupSpec } from './form';

export function GroupCreate() {
  const form = useForm<GroupDto, HttpError, GroupFormValues, ReturnType<typeof toGroupSpec>>({
    initialValues: blankGroup,
    transformValues: toGroupSpec,
    refineCoreProps: { resource: 'groups', action: 'create', redirect: 'show' },
  });

  return (
    <Create title="New group" saveButtonProps={form.saveButtonProps}>
      <GroupFormFields form={form} />
    </Create>
  );
}
