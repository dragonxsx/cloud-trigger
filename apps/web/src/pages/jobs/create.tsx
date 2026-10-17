import type { HttpError } from '@refinedev/core';
import { Create, useForm } from '@refinedev/mantine';

import type { JobDto } from '../../lib/api';
import { type JobFormValues, JobFormFields, blankJob, toSpec } from './form';

export function JobCreate() {
  const form = useForm<JobDto, HttpError, JobFormValues, ReturnType<typeof toSpec>>({
    initialValues: blankJob,
    transformValues: toSpec,
    refineCoreProps: { resource: 'jobs', action: 'create', redirect: 'show' },
  });

  return (
    <Create title="New job" saveButtonProps={form.saveButtonProps}>
      <JobFormFields form={form} />
    </Create>
  );
}
