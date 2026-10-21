import { type HttpError, useParsed } from '@refinedev/core';
import { Edit, useForm } from '@refinedev/mantine';

import {
  PageHeading,
  backIcon,
  pageBreadcrumb,
  saveWithInvalidFocus,
} from '../../components/page-chrome';
import { RecordLoadError } from '../../components/PageState';
import { usePageTitle } from '../../components/usePageTitle';
import type { GroupDto } from '../../lib/api';
import { focusFirstInvalidField } from '../../lib/errors';
import {
  type GroupFormValues,
  GroupFormFields,
  blankGroup,
  toGroupSpec,
  validateGroup,
} from './form';

export function GroupEdit() {
  const { id } = useParsed();
  const form = useForm<GroupDto, HttpError, GroupFormValues, ReturnType<typeof toGroupSpec>>({
    initialValues: blankGroup,
    validate: validateGroup,
    transformValues: toGroupSpec,
    refineCoreProps: {
      resource: 'groups',
      ...(id !== undefined && { id }),
      action: 'edit',
      redirect: 'show',
      mutationMode: 'pessimistic',
      onMutationError: () => focusFirstInvalidField(),
    },
  });
  const query = form.refineCore.query;
  const name = query?.data?.data.name;
  usePageTitle(name === undefined ? undefined : `Edit ${name}`, 'Groups');

  if (query?.isError) {
    return (
      <RecordLoadError
        error={query.error}
        onRetry={() => void query.refetch()}
        resource="Group"
        listPath="/groups"
        listLabel="Groups"
      />
    );
  }

  return (
    <Edit
      title={<PageHeading>{name === undefined ? 'Edit group' : `Edit ${name}`}</PageHeading>}
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      saveButtonProps={saveWithInvalidFocus(form)}
    >
      <GroupFormFields form={form} />
    </Edit>
  );
}
