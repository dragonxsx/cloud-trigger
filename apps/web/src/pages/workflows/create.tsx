import type { HttpError } from '@refinedev/core';
import { Create, useForm } from '@refinedev/mantine';

import {
  PageHeading,
  backIcon,
  pageBreadcrumb,
  saveWithInvalidFocus,
} from '../../components/page-chrome';
import type { WorkflowDto } from '../../lib/api';
import { focusFirstInvalidField } from '../../lib/errors';
import {
  type WorkflowFormValues,
  WorkflowFormFields,
  blankWorkflow,
  toWorkflowSpec,
  validateWorkflow,
} from './form';

export function WorkflowCreate() {
  const form = useForm<
    WorkflowDto,
    HttpError,
    WorkflowFormValues,
    ReturnType<typeof toWorkflowSpec>
  >({
    initialValues: blankWorkflow,
    validate: validateWorkflow,
    transformValues: toWorkflowSpec,
    refineCoreProps: {
      resource: 'workflows',
      action: 'create',
      redirect: 'show',
      onMutationError: () => focusFirstInvalidField(),
    },
  });

  return (
    <Create
      title={<PageHeading>New workflow</PageHeading>}
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      saveButtonProps={saveWithInvalidFocus(form)}
    >
      <WorkflowFormFields form={form} />
    </Create>
  );
}
