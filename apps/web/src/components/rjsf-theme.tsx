import {
  ActionIcon,
  Button,
  Checkbox,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import type { RegistryWidgetsType, TemplatesType, WidgetProps } from '@rjsf/utils';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { sentenceCase } from 'change-case';
import dayjs from 'dayjs';

import { client } from '../lib/api';

const ACRONYMS = new Set(['url', 'http', 'id', 'ms']);
export const humanize = (key: string): string =>
  sentenceCase(key)
    .split(' ')
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word))
    .join(' ');

const common = (p: WidgetProps) => ({
  ...(p.label ? { label: p.schema.title ?? humanize(p.label) } : {}),
  ...(p.required ? { required: true } : {}),
  ...(p.rawErrors?.length ? { error: p.rawErrors.join(', ') } : {}),
  ...(p.placeholder ? { placeholder: p.placeholder } : {}),
  disabled: p.disabled === true || p.readonly === true,
});
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
      description="Your local time"
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
      description="Wall-clock time in the trigger's time zone"
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

  return (
    <Select
      {...common(p)}
      data={options}
      value={p.value === undefined ? null : toInputText(p.value)}
      onChange={(v) =>
        p.onChange(p.options.enumOptions?.find((o) => toInputText(o.value) === v)?.value)
      }
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
  job: JobWidget,
};

export const templates: Partial<TemplatesType> = {
  FieldTemplate: ({ children, description, hidden, schema }) =>
    hidden ? (
      <>{children}</>
    ) : (
      <Stack spacing={2}>
        {children}
        {schema.type !== 'object' && description}
      </Stack>
    ),
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
  ObjectFieldTemplate: ({ title, properties, onAddProperty, schema, fieldPathId }) => (
    <Stack spacing="sm">
      {fieldPathId.path.length > 0 && title && (
        <Text weight={600} size="sm">
          {schema.title ?? humanize(title)}
        </Text>
      )}
      {fieldPathId.path.length > 0 && typeof schema.description === 'string' && (
        <Text size="xs" color="dimmed" mt={-8}>
          {schema.description}
        </Text>
      )}
      {properties
        .filter((p) => !p.hidden)
        .map((p) => (
          <div key={p.name}>{p.content}</div>
        ))}
      {schema.additionalProperties !== undefined && schema.additionalProperties !== false && (
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
  ),
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
        />
        <div style={{ flex: 2 }}>{children}</div>
        <ActionIcon
          color="red"
          variant="subtle"
          mb={4}
          aria-label="Remove"
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
      <ActionIcon color="red" variant="subtle" aria-label="Remove" onClick={onClick}>
        <IconTrash size={16} />
      </ActionIcon>
    ),
    MoveUpButton: () => null,
    MoveDownButton: () => null,
    CopyButton: () => null,
    ClearButton: () => null,
  },
};
