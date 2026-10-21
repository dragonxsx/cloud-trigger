import { Title } from '@mantine/core';
import { type HttpError, useParsed } from '@refinedev/core';
import { Edit, ListButton, SaveButton, useForm } from '@refinedev/mantine';

import { backIcon, pageBreadcrumb, saveWithInvalidFocus } from '../../components/page-chrome';
import { RecordLoadError } from '../../components/PageState';
import { usePageTitle } from '../../components/usePageTitle';
import type { JobDto } from '../../lib/api';
import { focusFirstInvalidField } from '../../lib/errors';
import { type JobFormValues, JobFormFields, blankJob, toSpec, validateJob } from './form';

export function JobEdit() {
  const { id } = useParsed();
  const form = useForm<JobDto, HttpError, JobFormValues, ReturnType<typeof toSpec>>({
    initialValues: blankJob,
    validate: validateJob,
    transformValues: toSpec,
    refineCoreProps: {
      resource: 'jobs',
      ...(id !== undefined && { id }),
      action: 'edit',
      redirect: 'show',
      mutationMode: 'pessimistic',
      onMutationError: () => focusFirstInvalidField(),
    },
  });
  const query = form.refineCore.query;
  const name = query?.data?.data.name;
  usePageTitle(name === undefined ? 'Edit job' : `Edit ${name}`, 'Jobs');
  const saveButtonProps = saveWithInvalidFocus(form);

  if (query?.isError) {
    return (
      <RecordLoadError
        error={query.error}
        onRetry={() => void query.refetch()}
        resource="Job"
        listPath="/jobs"
        listLabel="Jobs"
      />
    );
  }

  return (
    <Edit
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      title={
        <Title order={1} size="h3">
          {name === undefined ? 'Edit job' : `Edit ${name}`}
        </Title>
      }
      saveButtonProps={saveButtonProps}
      headerButtons={
        <>
          <ListButton resource="jobs" />
          <SaveButton {...saveButtonProps} />
        </>
      }
    >
      <JobFormFields form={form} />
    </Edit>
  );
}
