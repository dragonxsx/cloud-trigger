import type { HttpError } from '@refinedev/core';
import { Edit, useForm } from '@refinedev/mantine';

import type { JobDto } from '../../lib/api';
import { type JobFormValues, JobFormFields, blankJob, toSpec } from './form';

export function JobEdit() {
  const form = useForm<JobDto, HttpError, JobFormValues, ReturnType<typeof toSpec>>({
    initialValues: blankJob,
    transformValues: toSpec,
    refineCoreProps: {
      resource: 'jobs',
      action: 'edit',
      redirect: 'show',
      mutationMode: 'pessimistic',
    },
  });

  return (
    <Edit saveButtonProps={form.saveButtonProps}>
      <JobFormFields form={form} />
    </Edit>
  );
}
