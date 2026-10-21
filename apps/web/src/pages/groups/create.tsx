import type { HttpError } from '@refinedev/core';
import { Create, useForm } from '@refinedev/mantine';

import {
  PageHeading,
  backIcon,
  pageBreadcrumb,
  saveWithInvalidFocus,
} from '../../components/page-chrome';
import type { GroupDto } from '../../lib/api';
import { focusFirstInvalidField } from '../../lib/errors';
import {
  type GroupFormValues,
  GroupFormFields,
  blankGroup,
  toGroupSpec,
  validateGroup,
} from './form';

export function GroupCreate() {
  const form = useForm<GroupDto, HttpError, GroupFormValues, ReturnType<typeof toGroupSpec>>({
    initialValues: blankGroup,
    validate: validateGroup,
    transformValues: toGroupSpec,
    refineCoreProps: {
      resource: 'groups',
      action: 'create',
      redirect: 'show',
      onMutationError: () => focusFirstInvalidField(),
    },
  });

  return (
    <Create
      title={<PageHeading>New group</PageHeading>}
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      saveButtonProps={saveWithInvalidFocus(form)}
    >
      <GroupFormFields form={form} />
    </Create>
  );
}
