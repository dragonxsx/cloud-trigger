import type { HttpError } from '@refinedev/core';
import { Create, useForm } from '@refinedev/mantine';

import type { WorkflowDto } from '../../lib/api';
import { type WorkflowFormValues, WorkflowFormFields, blankWorkflow, toWorkflowSpec } from './form';

export function WorkflowCreate() {
  const form = useForm<
    WorkflowDto,
    HttpError,
    WorkflowFormValues,
    ReturnType<typeof toWorkflowSpec>
  >({
    initialValues: blankWorkflow,
    transformValues: toWorkflowSpec,
    refineCoreProps: { resource: 'workflows', action: 'create', redirect: 'show' },
  });

  return (
    <Create title="New workflow" saveButtonProps={form.saveButtonProps}>
      <WorkflowFormFields form={form} />
    </Create>
  );
}
