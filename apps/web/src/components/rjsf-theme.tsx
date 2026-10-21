import { isRecord } from '@cloud-trigger/core';
import {
  ActionIcon,
  Button,
  Checkbox,
  Collapse,
  Group,
  MultiSelect,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import {
  type ArrayFieldItemTemplateProps,
  type ArrayFieldTemplateProps,
  type FieldTemplateProps,
  type ObjectFieldTemplateProps,
  type OptionalDataControlsTemplateProps,
  type RegistryWidgetsType,
  type TemplatesType,
  type WidgetProps,
  deepEquals,
  getUiOptions,
} from '@rjsf/utils';
import { IconChevronDown, IconChevronRight, IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { sentenceCase } from 'change-case';
import dayjs from 'dayjs';
import { createContext, useContext, useState } from 'react';
import { z } from 'zod';

import { client } from '../lib/api';

const ACRONYMS = new Set(['url', 'http', 'id', 'json', 'api', 'tls', 'smtp', 'hmac']);
const humanizeWord = (word: string): string => {
  const lower = word.toLowerCase();
  if (lower === 'ms') {
    return '(ms)';
  }

  return ACRONYMS.has(lower) ? word.toUpperCase() : word;
};
export const humanize = (key: string): string =>
  sentenceCase(key).split(' ').map(humanizeWord).join(' ');

const defaultText = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const joinText = (...parts: readonly (string | undefined)[]): string | undefined => {
  const text = parts.filter((part) => part !== undefined && part !== '').join(' ');

  return text === '' ? undefined : text;
};

const labelOf = (p: WidgetProps): string | undefined =>
  p.label ? (p.schema.title ?? humanize(p.label)) : undefined;

const common = (p: WidgetProps, fallbackLabel?: string) => {
  const label = labelOf(p) ?? fallbackLabel;
  const description = stringOrUndefined(p.schema.description);
  const placeholder = p.placeholder || defaultText(p.schema.default);

  return {
    ...(label ? { label } : { 'aria-label': humanize(p.name || p.id) }),
    ...(description ? { description } : {}),
    ...(p.required ? { required: true } : {}),
    ...(p.rawErrors?.length ? { error: p.rawErrors.join(', ') } : {}),
    ...(placeholder ? { placeholder } : {}),
    disabled: p.disabled === true || p.readonly === true,
  };
};
const toInputText = (v: unknown): string => {
  if (typeof v === 'string') {
    return v;
  }
  if (v === undefined || v === null) {
    return '';
  }

  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
};

const isDiscriminatorConstant = (schema: WidgetProps['schema']): boolean =>
  schema.const !== undefined;

const NO_AUTOFILL = { autoComplete: 'off', 'data-1p-ignore': true, 'data-lpignore': 'true' };
const NO_PASSWORD_AUTOFILL = {
  autoComplete: 'new-password',
  'data-1p-ignore': true,
  'data-lpignore': 'true',
};

function TextWidget(p: WidgetProps) {
  if (isDiscriminatorConstant(p.schema)) {
    return null;
  }
  if (p.schema.type === 'integer' || p.schema.type === 'number') {
    return (
      <NumberInput
        {...common(p)}
        value={typeof p.value === 'number' ? p.value : undefined}
        precision={p.schema.type === 'number' ? 3 : 0}
        removeTrailingZeros
        onChange={(v) => p.onChange(v)}
      />
    );
  }

  return (
    <TextInput
      {...common(p)}
      {...NO_AUTOFILL}
      value={toInputText(p.value)}
      onChange={(e) =>
        p.onChange(e.currentTarget.value === '' ? p.options.emptyValue : e.currentTarget.value)
      }
    />
  );
}

const isoToLocalInputValue = (iso: unknown): string => {
  const local = typeof iso === 'string' && iso !== '' ? dayjs(iso) : undefined;

  return local?.isValid() ? local.format('YYYY-MM-DD[T]HH:mm') : '';
};

function DateTimeWidget(p: WidgetProps) {
  return (
    <TextInput
      {...common(p)}
      type="datetime-local"
      description={joinText(stringOrUndefined(p.schema.description), 'Your local time.')}
      value={isoToLocalInputValue(p.value)}
      onChange={(e) =>
        p.onChange(
          e.currentTarget.value === '' ? undefined : new Date(e.currentTarget.value).toISOString(),
        )
      }
    />
  );
}

function WallClockWidget(p: WidgetProps) {
  return (
    <TextInput
      {...common(p)}
      type="datetime-local"
      description={joinText(
        stringOrUndefined(p.schema.description),
        "Wall-clock time in the trigger's time zone.",
      )}
      value={typeof p.value === 'string' ? p.value.slice(0, 16) : ''}
      onChange={(e) =>
        p.onChange(e.currentTarget.value === '' ? undefined : e.currentTarget.value.slice(0, 16))
      }
    />
  );
}

function PasswordWidget(p: WidgetProps) {
  return (
    <PasswordInput
      {...common(p)}
      {...NO_PASSWORD_AUTOFILL}
      value={toInputText(p.value)}
      onChange={(e) =>
        p.onChange(e.currentTarget.value === '' ? p.options.emptyValue : e.currentTarget.value)
      }
    />
  );
}

function TextareaWidget(p: WidgetProps) {
  return (
    <Textarea
      {...common(p)}
      {...NO_AUTOFILL}
      autosize
      minRows={3}
      value={toInputText(p.value)}
      styles={{ input: { fontFamily: '"JetBrains Mono Variable", monospace', fontSize: 13 } }}
      onChange={(e) => p.onChange(e.currentTarget.value)}
    />
  );
}

function SelectWidget(p: WidgetProps) {
  const options = (p.options.enumOptions ?? []).map((o) => ({
    value: toInputText(o.value),
    label: o.label,
  }));
  const toValue = (v: string | null): unknown =>
    p.options.enumOptions?.find((o) => toInputText(o.value) === v)?.value;

  if (p.multiple) {
    return (
      <MultiSelect
        {...common(p)}
        data={options}
        value={Array.isArray(p.value) ? p.value.map(toInputText) : []}
        onChange={(values) => p.onChange(values.map(toValue))}
      />
    );
  }

  return (
    <Select
      {...common(p, 'Format')}
      data={options}
      value={p.value === undefined ? null : toInputText(p.value)}
      onChange={(v) => p.onChange(toValue(v))}
    />
  );
}

const ItemEnum = z.object({ enum: z.array(z.union([z.string(), z.number()])) });

const textItems = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(toInputText).filter((v) => v !== '') : [];

function TagsWidget(p: WidgetProps) {
  const choices = ItemEnum.safeParse(p.schema.items);
  const values = textItems(p.value);

  if (choices.success) {
    const options = choices.data.enum.map((v) => ({
      value: String(v),
      label: humanize(String(v)),
    }));

    return (
      <MultiSelect
        {...common(p)}
        data={options}
        value={values}
        onChange={(next) => p.onChange(choices.data.enum.filter((v) => next.includes(String(v))))}
      />
    );
  }

  return (
    <MultiSelect
      {...common(p)}
      {...NO_AUTOFILL}
      data={values}
      value={values}
      searchable
      creatable
      clearable
      getCreateLabel={(query) => `Add "${query}"`}
      onCreate={(query) => query.trim() || null}
      onChange={(next) => p.onChange(next)}
    />
  );
}

const TIME_ZONES: readonly string[] = [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])];

function TimeZoneWidget(p: WidgetProps) {
  const value = typeof p.value === 'string' && p.value !== '' ? p.value : null;
  const data = value === null || TIME_ZONES.includes(value) ? TIME_ZONES : [value, ...TIME_ZONES];

  return (
    <Select
      {...common(p)}
      searchable
      nothingFound="No matching time zone"
      data={[...data]}
      value={value}
      onChange={(v) => p.onChange(v ?? undefined)}
    />
  );
}

function JobWidget(p: WidgetProps) {
  const jobs = useQuery({
    queryKey: ['jobs', 'picker'],
    queryFn: () => client.jobs.list({ limit: 200 }),
    staleTime: 30_000,
  });

  return (
    <Select
      {...common(p)}
      searchable
      nothingFound="No matching job"
      data={(jobs.data?.items ?? []).map((j) => ({ value: j.id, label: j.name }))}
      value={typeof p.value === 'string' ? p.value : null}
      onChange={(v) => p.onChange(v ?? undefined)}
    />
  );
}

function CheckboxWidget(p: WidgetProps) {
  return (
    <Checkbox
      {...common(p)}
      checked={p.value === true}
      onChange={(e) => p.onChange(e.currentTarget.checked)}
    />
  );
}

export const widgets: RegistryWidgetsType = {
  TextWidget,
  DateTimeWidget,
  'wall-clock': WallClockWidget,
  PasswordWidget,
  TextareaWidget,
  SelectWidget,
  CheckboxWidget,
  tags: TagsWidget,
  timezone: TimeZoneWidget,
  job: JobWidget,
};

const DESCRIBED_BY_WIDGET = new Set(['string', 'number', 'integer', 'boolean', 'array']);

function FieldTemplate({ children, description, hidden, schema }: FieldTemplateProps) {
  if (hidden) {
    return <>{children}</>;
  }
  const describedByWidget = typeof schema.type === 'string' && DESCRIBED_BY_WIDGET.has(schema.type);

  return (
    <Stack spacing={2}>
      {children}
      {schema.type !== 'object' && !describedByWidget && description}
    </Stack>
  );
}

const AdvancedKeys = z.array(z.string());
const advancedKeysOf = (uiSchema: unknown): readonly string[] => {
  const parsed = AdvancedKeys.safeParse(isRecord(uiSchema) ? uiSchema['ui:advanced'] : undefined);

  return parsed.success ? parsed.data : [];
};
const AdvancedLabel = z.string();
const advancedLabelOf = (uiSchema: unknown): string => {
  const parsed = AdvancedLabel.safeParse(
    isRecord(uiSchema) ? uiSchema['ui:advancedLabel'] : undefined,
  );

  return parsed.success ? parsed.data : 'More options';
};

const isOneOfBranch = (schema: ObjectFieldTemplateProps['schema']): boolean =>
  Object.values(schema.properties ?? {}).some((prop) => isRecord(prop) && 'const' in prop);

const propertyDefault = (schema: ObjectFieldTemplateProps['schema'], key: string): unknown => {
  const prop = schema.properties?.[key];

  return isRecord(prop) ? prop['default'] : undefined;
};

const hasCustomValue = (
  schema: ObjectFieldTemplateProps['schema'],
  formData: unknown,
  keys: readonly string[],
): boolean =>
  isRecord(formData) &&
  keys.some(
    (key) =>
      formData[key] !== undefined && !deepEquals(formData[key], propertyDefault(schema, key)),
  );

const hasErrorsIn = (errorSchema: unknown, keys: readonly string[]): boolean =>
  isRecord(errorSchema) && keys.some((key) => errorSchema[key] !== undefined);

interface OptionalHeading {
  readonly label: string;
  readonly description: string | undefined;
}
const OptionalHeadingContext = createContext<OptionalHeading>({
  label: '',
  description: undefined,
});

function OptionalDataControlsTemplate({
  onAddClick,
  onRemoveClick,
}: OptionalDataControlsTemplateProps) {
  const heading = useContext(OptionalHeadingContext);
  const toggle = onRemoveClick ?? onAddClick;

  if (!toggle) {
    return (
      <Stack spacing={2}>
        <Text weight={600} size="sm">
          {heading.label}
        </Text>
        <Text size="xs" color="dimmed">
          Not set
        </Text>
      </Stack>
    );
  }

  return (
    <Switch
      label={heading.label}
      {...(heading.description ? { description: heading.description } : {})}
      checked={onRemoveClick !== undefined}
      onChange={() => toggle()}
    />
  );
}

function ObjectFieldTemplate({
  title,
  properties,
  onAddProperty,
  schema,
  fieldPathId,
  optionalDataControl,
  uiSchema,
  formData,
  errorSchema,
}: ObjectFieldTemplateProps) {
  const visible = properties.filter((p) => !p.hidden);
  const advancedKeys = advancedKeysOf(uiSchema);
  const advanced = visible.filter((p) => advancedKeys.includes(p.name));
  const collapsible = advanced.length >= 2 && advanced.length < visible.length;
  const primary = collapsible ? visible.filter((p) => !advancedKeys.includes(p.name)) : visible;
  const [showAdvanced, setShowAdvanced] = useState(() =>
    hasCustomValue(schema, formData, advancedKeys),
  );
  const advancedOpen = showAdvanced || hasErrorsIn(errorSchema, advancedKeys);
  const nested = fieldPathId.path.length > 0;
  const heading = schema.title ?? (title ? humanize(title) : '');
  const description = stringOrUndefined(schema.description);
  const isMap = schema.additionalProperties !== undefined && schema.additionalProperties !== false;

  return (
    <Stack spacing="sm">
      {optionalDataControl ? (
        <OptionalHeadingContext.Provider value={{ label: heading, description }}>
          {optionalDataControl}
        </OptionalHeadingContext.Provider>
      ) : (
        <>
          {nested && heading !== '' && !isOneOfBranch(schema) && (
            <Text weight={600} size="sm">
              {heading}
            </Text>
          )}
          {nested && description && (
            <Text size="xs" color="dimmed" mt={-8}>
              {description}
            </Text>
          )}
        </>
      )}
      {primary.length > 0 && (
        <Stack spacing="sm" pl={optionalDataControl ? 'md' : 0}>
          {primary.map((p) => (
            <div key={p.name}>{p.content}</div>
          ))}
        </Stack>
      )}
      {collapsible && (
        <>
          <Group>
            <Button
              variant="subtle"
              size="xs"
              compact
              leftIcon={
                advancedOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />
              }
              aria-expanded={advancedOpen}
              onClick={() => setShowAdvanced(!advancedOpen)}
            >
              {advancedLabelOf(uiSchema)}
            </Button>
          </Group>
          <Collapse in={advancedOpen}>
            {advancedOpen && (
              <Stack spacing="sm">
                {advanced.map((p) => (
                  <div key={p.name}>{p.content}</div>
                ))}
              </Stack>
            )}
          </Collapse>
        </>
      )}
      {isMap && (
        <Group>
          <Button
            size="xs"
            variant="light"
            leftIcon={<IconPlus size={14} />}
            onClick={onAddProperty}
          >
            Add {title ? humanize(title).toLowerCase().replace(/s$/, '') : 'entry'}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function ArrayFieldTemplate({
  canAdd,
  disabled,
  readonly,
  items,
  onAddClick,
  rawErrors,
  required,
  schema,
  title,
  uiSchema,
}: ArrayFieldTemplateProps) {
  const uiTitle = stringOrUndefined(getUiOptions(uiSchema).title);
  const heading = uiTitle ?? schema.title ?? (title ? humanize(title) : '');
  const description = stringOrUndefined(schema.description);

  return (
    <Stack spacing="xs">
      {heading !== '' && (
        <Text weight={500} size="sm">
          {heading}
          {required && (
            <Text component="span" color="red" aria-hidden>
              {' *'}
            </Text>
          )}
        </Text>
      )}
      {description && (
        <Text size="xs" color="dimmed" mt={-6}>
          {description}
        </Text>
      )}
      {items}
      {rawErrors && rawErrors.length > 0 && (
        <Text size="xs" color="red">
          {rawErrors.join(', ')}
        </Text>
      )}
      {canAdd && (
        <Group>
          <Button
            size="xs"
            variant="light"
            leftIcon={<IconPlus size={14} />}
            disabled={disabled === true || readonly === true}
            onClick={onAddClick}
          >
            Add {heading === '' ? 'item' : heading.toLowerCase().replace(/s$/, '')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function ArrayFieldItemTemplate({
  children,
  buttonsProps,
  hasToolbar,
}: ArrayFieldItemTemplateProps) {
  const removable = hasToolbar && buttonsProps.hasRemove;

  return (
    <Group align="flex-end" noWrap spacing="xs">
      <div style={{ flex: 1 }}>{children}</div>
      {removable && (
        <ActionIcon
          color="red"
          variant="subtle"
          mb={4}
          aria-label={`Remove item ${buttonsProps.index + 1}`}
          disabled={buttonsProps.disabled === true || buttonsProps.readonly === true}
          onClick={buttonsProps.onRemoveItem}
        >
          <IconTrash size={16} />
        </ActionIcon>
      )}
    </Group>
  );
}

export const templates: Partial<TemplatesType> = {
  FieldTemplate,
  DescriptionFieldTemplate: ({ description }) =>
    description ? (
      <Text size="xs" color="dimmed">
        {description}
      </Text>
    ) : null,
  TitleFieldTemplate: ({ title }) => (
    <Text weight={600} size="sm">
      {humanize(title)}
    </Text>
  ),
  ObjectFieldTemplate,
  ArrayFieldTemplate,
  ArrayFieldItemTemplate,
  OptionalDataControlsTemplate,
  WrapIfAdditionalTemplate: ({
    children,
    label: keyLabel,
    onKeyRenameBlur,
    onRemoveProperty,
    schema,
  }) => {
    const isAdditional = '__additional_property' in schema;
    if (!isAdditional) {
      return <>{children}</>;
    }

    return (
      <Group align="flex-end" noWrap spacing="xs">
        <TextInput
          label="Name"
          defaultValue={keyLabel}
          onBlur={onKeyRenameBlur}
          style={{ flex: 1 }}
          {...NO_AUTOFILL}
        />
        <div style={{ flex: 2 }}>{children}</div>
        <ActionIcon
          color="red"
          variant="subtle"
          mb={4}
          aria-label={`Remove ${keyLabel}`}
          onClick={onRemoveProperty}
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Group>
    );
  },
  ErrorListTemplate: () => null,
  ButtonTemplates: {
    SubmitButton: () => null,
    AddButton: ({ onClick }) => (
      <Button size="xs" variant="light" leftIcon={<IconPlus size={14} />} onClick={onClick}>
        Add
      </Button>
    ),
    RemoveButton: ({ onClick }) => (
      <ActionIcon color="red" variant="subtle" aria-label="Remove" mb={4} onClick={onClick}>
        <IconTrash size={16} />
      </ActionIcon>
    ),
    MoveUpButton: () => null,
    MoveDownButton: () => null,
    CopyButton: () => null,
    ClearButton: () => null,
  },
};
