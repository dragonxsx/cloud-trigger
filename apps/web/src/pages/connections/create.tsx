import { Title } from '@mantine/core';
import type { HttpError } from '@refinedev/core';
import { Create, useForm } from '@refinedev/mantine';

import { backIcon, pageBreadcrumb, saveWithInvalidFocus } from '../../components/page-chrome';
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

export function ConnectionCreate() {
  usePageTitle('New connection', 'Connections');
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
      action: 'create',
      redirect: 'show',
      onMutationError: () => focusFirstInvalidField(),
    },
  });

  return (
    <Create
      goBack={backIcon}
      breadcrumb={pageBreadcrumb}
      title={
        <Title order={1} size="h3">
          New connection
        </Title>
      }
      saveButtonProps={saveWithInvalidFocus(form)}
    >
      <ConnectionFormFields form={form} />
    </Create>
  );
}
