import { Title } from '@mantine/core';
import type { HttpError } from '@refinedev/core';
import { Create, SaveButton, useForm } from '@refinedev/mantine';

import { backIcon, pageBreadcrumb, saveWithInvalidFocus } from '../../components/page-chrome';
import { usePageTitle } from '../../components/usePageTitle';
import type { JobDto } from '../../lib/api';
import { focusFirstInvalidField } from '../../lib/errors';
import { type JobFormValues, JobFormFields, blankJob, toSpec, validateJob } from './form';

export function JobCreate() {
  usePageTitle('New job', 'Jobs');
  const form = useForm<JobDto, HttpError, JobFormValues, ReturnType<typeof toSpec>>({
    initialValues: blankJob,
    validate: validateJob,
    transformValues: toSpec,
    refineCoreProps: {
      resource: 'jobs',
      action: 'create',
      redirect: 'show',
      onMutationError: () => focusFirstInvalidField(),
    },
  });
  const saveButtonProps = saveWithInvalidFocus(form);

  return (
    <Create
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      title={
        <Title order={1} size="h3">
          New job
        </Title>
      }
      saveButtonProps={saveButtonProps}
      headerButtons={<SaveButton {...saveButtonProps} />}
    >
      <JobFormFields form={form} />
    </Create>
  );
}
