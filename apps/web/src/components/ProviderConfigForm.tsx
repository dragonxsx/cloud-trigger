import { isRecord } from '@cloud-trigger/core';
import { Select, Stack, Text } from '@mantine/core';
import Form from '@rjsf/core';
import { type ErrorSchema, ErrorSchemaBuilder, type RJSFSchema, type UiSchema } from '@rjsf/utils';
import { customizeValidator } from '@rjsf/validator-ajv8';
import Ajv2020 from 'ajv/dist/2020';
import { useMemo } from 'react';

import type { ProviderDto } from '../lib/api';
import type { ConfigIssueDto } from '../lib/errors';
import { humanize, templates, widgets } from './rjsf-theme';

const validator = customizeValidator({ AjvClass: Ajv2020, ajvOptionsOverrides: { strict: false } });
const metaAjv = new Ajv2020({ strict: false });

const isJsonSchema = (
  value: Record<string, unknown>,
): value is RJSFSchema & Record<string, unknown> => metaAjv.validateSchema(value) === true;

const BOUNDS = new Set(['startAt', 'endAt', 'maxCount']);
const COLLAPSIBLE_TYPES = new Set(['integer', 'number', 'boolean', 'array', 'object']);
const NO_OPTIONAL_TOGGLE = { 'ui:enableOptionalDataFieldForType': [] };

const requiredKeys = (schema: Record<string, unknown>): ReadonlySet<unknown> =>
  new Set(Array.isArray(schema['required']) ? schema['required'] : []);

const isAdvanced = (key: string, prop: Record<string, unknown>, required: ReadonlySet<unknown>) =>
  BOUNDS.has(key) ||
  (!required.has(key) &&
    'default' in prop &&
    typeof prop['type'] === 'string' &&
    COLLAPSIBLE_TYPES.has(prop['type']));

const isFreeTextList = (prop: Record<string, unknown>): boolean => {
  const items = prop['items'];

  return prop['type'] === 'array' && isRecord(items) && items['type'] === 'string';
};

const inheritedPlaceholder = (value: unknown): UiSchema | undefined =>
  (typeof value === 'string' && value !== '') || typeof value === 'number'
    ? { 'ui:placeholder': String(value) }
    : undefined;

const childOf = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

function propertyUi(
  key: string,
  prop: Record<string, unknown>,
  inherited: unknown,
): UiSchema | undefined {
  if (prop['secret'] === true) {
    return { 'ui:widget': 'password' };
  }
  if (prop['widget'] === 'job' || prop['widget'] === 'wall-clock') {
    return { 'ui:widget': prop['widget'] };
  }
  if (isRecord(prop['properties'])) {
    return uiSchemaFor(prop, false, inherited);
  }
  if (Array.isArray(prop['oneOf']) || Array.isArray(prop['anyOf'])) {
    return NO_OPTIONAL_TOGGLE;
  }
  if (isRecord(prop['additionalProperties'])) {
    return {
      ...NO_OPTIONAL_TOGGLE,
      ...(prop['additionalProperties']['secret'] === true && {
        additionalProperties: { 'ui:widget': 'password' },
      }),
    };
  }
  if (isFreeTextList(prop)) {
    return { 'ui:widget': 'tags' };
  }
  if (key === 'timezone' && prop['type'] === 'string') {
    return { 'ui:widget': 'timezone' };
  }
  if (key === 'template' || key === 'body') {
    return { 'ui:widget': 'textarea' };
  }

  return undefined;
}

function uiSchemaFor(schema: unknown, root = true, inherited?: unknown): UiSchema {
  const ui: UiSchema = root
    ? {
        'ui:submitButtonOptions': { norender: true },
        'ui:globalOptions': { enableOptionalDataFieldForType: ['object'] },
        ...NO_OPTIONAL_TOGGLE,
      }
    : {};
  const properties = isRecord(schema) ? schema['properties'] : undefined;
  if (!isRecord(schema) || !isRecord(properties)) {
    return ui;
  }
  const required = requiredKeys(schema);
  const advanced: string[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    if (!isRecord(prop)) {
      continue;
    }
    const value = childOf(inherited, key);
    const propUi = propertyUi(key, prop, value);
    const hint =
      isRecord(prop['properties']) || prop['secret'] === true
        ? undefined
        : inheritedPlaceholder(value);
    if (propUi || hint) {
      ui[key] = { ...propUi, ...hint };
    }
    if (root && isAdvanced(key, prop, required)) {
      advanced.push(key);
    }
  }
  if (advanced.length > 0) {
    ui['ui:advanced'] = advanced;
    ui['ui:advancedLabel'] = advanced.every((key) => BOUNDS.has(key))
      ? 'Limits: start, end and run count'
      : 'More options';
  }

  return ui;
}

const TYPE_TITLES = new Map([
  ['string', 'Text'],
  ['number', 'Number'],
  ['integer', 'Whole number'],
  ['boolean', 'True or false'],
  ['null', 'Null'],
  ['array', 'List'],
  ['object', 'Object'],
]);

const withBranchTitle = (branch: unknown): unknown =>
  isRecord(branch) && branch['title'] === undefined && typeof branch['type'] === 'string'
    ? { ...branch, title: TYPE_TITLES.get(branch['type']) ?? humanize(branch['type']) }
    : branch;

function titleBranches(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item: unknown) => titleBranches(item));
  }
  if (!isRecord(schema)) {
    return schema;
  }

  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      const titled = titleBranches(value);

      return [
        key,
        (key === 'anyOf' || key === 'oneOf') && Array.isArray(titled)
          ? titled.map(withBranchTitle)
          : titled,
      ];
    }),
  );
}

const formSchemaOf = (provider: ProviderDto | undefined) => {
  const titled = provider ? titleBranches(provider.configSchema) : undefined;

  return isRecord(titled) && isJsonSchema(titled) ? titled : undefined;
};

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
  readonly typeLocked?: boolean;
  readonly inherited?: unknown;
}

export function ProviderConfigForm({
  label,
  providers,
  type,
  config,
  configIssues,
  onTypeChange,
  onConfigChange,
  typeLocked = false,
  inherited,
}: Props) {
  const provider = providers.find((p) => p.type === type);
  const schema = useMemo(() => formSchemaOf(provider), [provider]);
  const uiSchema = useMemo(() => uiSchemaFor(schema, true, inherited), [schema, inherited]);
  const extraErrors = useMemo(() => toErrorSchema(configIssues), [configIssues]);

  return (
    <Stack spacing="sm">
      {!typeLocked && (
        <Select
          label={label}
          data={providers.map((p) => ({ value: p.type, label: p.displayName }))}
          value={type}
          onChange={(value) => value && onTypeChange(value)}
          {...(provider?.description ? { description: provider.description } : {})}
        />
      )}
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
