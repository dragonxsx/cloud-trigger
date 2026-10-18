import type { HttpError } from '@refinedev/core';
import { Edit, useForm } from '@refinedev/mantine';

import type { WorkflowDto } from '../../lib/api';
import { type WorkflowFormValues, WorkflowFormFields, blankWorkflow, toWorkflowSpec } from './form';

export function WorkflowEdit() {
  const form = useForm<
    WorkflowDto,
    HttpError,
    WorkflowFormValues,
    ReturnType<typeof toWorkflowSpec>
  >({
    initialValues: blankWorkflow,
    transformValues: toWorkflowSpec,
    refineCoreProps: {
      resource: 'workflows',
      action: 'edit',
      redirect: 'show',
      mutationMode: 'pessimistic',
    },
  });

  return (
    <Edit saveButtonProps={form.saveButtonProps}>
      <WorkflowFormFields form={form} />
    </Edit>
  );
}
