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
import type { WorkflowDto } from '../../lib/api';
import { focusFirstInvalidField } from '../../lib/errors';
import {
  type WorkflowFormValues,
  WorkflowFormFields,
  blankWorkflow,
  toWorkflowSpec,
  validateWorkflow,
} from './form';

export function WorkflowEdit() {
  const { id } = useParsed();
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
      ...(id !== undefined && { id }),
      action: 'edit',
      redirect: 'show',
      mutationMode: 'pessimistic',
      onMutationError: () => focusFirstInvalidField(),
    },
  });
  const query = form.refineCore.query;
  const name = query?.data?.data.name;
  usePageTitle(name === undefined ? undefined : `Edit ${name}`, 'Workflows');

  if (query?.isError) {
    return (
      <RecordLoadError
        error={query.error}
        onRetry={() => void query.refetch()}
        resource="Workflow"
        listPath="/workflows"
        listLabel="Workflows"
      />
    );
  }

  return (
    <Edit
      title={<PageHeading>{name === undefined ? 'Edit workflow' : `Edit ${name}`}</PageHeading>}
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      saveButtonProps={saveWithInvalidFocus(form)}
    >
      <WorkflowFormFields form={form} />
    </Edit>
  );
}
