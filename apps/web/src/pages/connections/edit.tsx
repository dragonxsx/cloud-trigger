import { Title } from '@mantine/core';
import { type HttpError, useParsed } from '@refinedev/core';
import { Edit, ListButton, SaveButton, useForm } from '@refinedev/mantine';

import { backIcon, pageBreadcrumb, saveWithInvalidFocus } from '../../components/page-chrome';
import { RecordLoadError } from '../../components/PageState';
import { usePageTitle } from '../../components/usePageTitle';
import type { ConnectionDto } from '../../lib/api';
import { focusFirstInvalidField } from '../../lib/errors';
import {
  type ConnectionFormValues,
  ConnectionFormFields,
  blankConnection,
  toConnectionSpec,
  validateConnection,
} from './form';

export function ConnectionEdit() {
  const { id } = useParsed();
  const form = useForm<
    ConnectionDto,
    HttpError,
    ConnectionFormValues,
    ReturnType<typeof toConnectionSpec>
  >({
    initialValues: blankConnection,
    validate: validateConnection,
    transformValues: toConnectionSpec,
    refineCoreProps: {
      resource: 'connections',
      ...(id !== undefined && { id }),
      action: 'edit',
      redirect: 'show',
      mutationMode: 'pessimistic',
      onMutationError: () => focusFirstInvalidField(),
    },
  });
  const query = form.refineCore.query;
  const record = query?.data?.data;
  const heading = record === undefined ? 'Edit connection' : `Edit ${record.name || record.key}`;
  usePageTitle(heading, 'Connections');
  const saveProps = saveWithInvalidFocus(form);

  if (query?.isError) {
    return (
      <RecordLoadError
        error={query.error}
        onRetry={() => void query.refetch()}
        resource="Connection"
        listPath="/connections"
        listLabel="Connections"
      />
    );
  }

  return (
    <Edit
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      title={
        <Title order={1} size="h3">
          {heading}
        </Title>
      }
      saveButtonProps={saveProps}
      headerButtons={
        <>
          <ListButton resource="connections" />
          <SaveButton {...saveProps} />
        </>
      }
    >
      <ConnectionFormFields form={form} editing />
    </Edit>
  );
}
