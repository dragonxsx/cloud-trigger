import { isRecord } from '@cloud-trigger/core';
import { Select, Stack, Text } from '@mantine/core';
import Form from '@rjsf/core';
import { type ErrorSchema, ErrorSchemaBuilder, type RJSFSchema, type UiSchema } from '@rjsf/utils';
import { customizeValidator } from '@rjsf/validator-ajv8';
import Ajv2020 from 'ajv/dist/2020';
import { useMemo } from 'react';

import type { ProviderDto } from '../lib/api';
import type { ConfigIssueDto } from '../lib/errors';
import { templates, widgets } from './rjsf-theme';

const validator = customizeValidator({ AjvClass: Ajv2020, ajvOptionsOverrides: { strict: false } });
const metaAjv = new Ajv2020({ strict: false });

const isJsonSchema = (
  value: Record<string, unknown>,
): value is RJSFSchema & Record<string, unknown> => metaAjv.validateSchema(value) === true;

function uiSchemaFor(schema: unknown, root = true): UiSchema {
  const ui: UiSchema = root ? { 'ui:submitButtonOptions': { norender: true } } : {};
  const properties = isRecord(schema) ? schema['properties'] : undefined;
  if (!isRecord(properties)) {
    return ui;
  }
  for (const [key, prop] of Object.entries(properties)) {
    if (!isRecord(prop)) {
      continue;
    }
    if (prop['secret'] === true) {
      ui[key] = { 'ui:widget': 'password' };
    } else if (isRecord(prop['properties'])) {
      ui[key] = uiSchemaFor(prop, false);
    } else if (key === 'template' || key === 'body') {
      ui[key] = { 'ui:widget': 'textarea' };
    }
  }

  return ui;
}

const toErrorSchema = (issues: readonly ConfigIssueDto[]): ErrorSchema<unknown> =>
  issues.reduce(
    (builder, issue) => builder.addErrors(issue.message, issue.path || undefined),
    new ErrorSchemaBuilder<unknown>(),
  ).ErrorSchema;

const OPTIONAL_OBJECTS_STAY_EMPTY = { emptyObjectFields: 'populateRequiredDefaults' } as const;

interface Props {
  readonly label: string;
  readonly providers: readonly ProviderDto[];
  readonly type: string;
  readonly config: unknown;
  readonly configIssues: readonly ConfigIssueDto[];
  readonly onTypeChange: (type: string) => void;
  readonly onConfigChange: (config: unknown) => void;
}

export function ProviderConfigForm({
  label,
  providers,
  type,
  config,
  configIssues,
  onTypeChange,
  onConfigChange,
}: Props) {
  const provider = providers.find((p) => p.type === type);
  const schema = useMemo(
    () => (provider && isJsonSchema(provider.configSchema) ? provider.configSchema : undefined),
    [provider],
  );
  const uiSchema = useMemo(() => uiSchemaFor(schema), [schema]);
  const extraErrors = useMemo(() => toErrorSchema(configIssues), [configIssues]);

  return (
    <Stack spacing="sm">
      <Select
        label={label}
        data={providers.map((p) => ({ value: p.type, label: p.displayName }))}
        value={type}
        onChange={(value) => value && onTypeChange(value)}
        {...(provider?.description ? { description: provider.description } : {})}
      />
      {schema ? (
        <Form
          key={type}
          schema={schema}
          uiSchema={uiSchema}
          validator={validator}
          widgets={widgets}
          templates={templates}
          formData={config}
          extraErrors={extraErrors}
          showErrorList={false}
          experimental_defaultFormStateBehavior={OPTIONAL_OBJECTS_STAY_EMPTY}
          onChange={(e) => onConfigChange(e.formData)}
        />
      ) : (
        <Text color="dimmed" size="sm">
          {provider ? 'This provider has no settings.' : 'Loading providers…'}
        </Text>
      )}
    </Stack>
  );
}
