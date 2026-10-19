import {
  Alert,
  List,
  MultiSelect,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertCircle, IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo } from 'react';

import { NotificationRulesEditor } from '../../components/NotificationRulesEditor';
import { PolicyFields } from '../../components/PolicyFields';
import { ProviderConfigForm } from '../../components/ProviderConfigForm';
import { TargetPicker } from '../../components/TargetPicker';
import { type JobCreateInput, type JobDto, type ProviderDto, client } from '../../lib/api';
import { type ConfigIssueDto, configIssues, errorMessage } from '../../lib/errors';
import { dateTime } from '../../lib/format';

export type JobFormValues = Pick<
  JobDto,
  | 'name'
  | 'description'
  | 'tags'
  | 'enabled'
  | 'groupId'
  | 'trigger'
  | 'input'
  | 'target'
  | 'notifications'
  | 'policy'
> & {
  version?: number;
};
export type JobForm = UseFormReturnType<
  JobFormValues,
  (values: JobFormValues) => JobCreateInput & { expectedVersion?: number }
>;

export const blankJob: JobFormValues = {
  name: '',
  description: '',
  tags: [],
  enabled: true,
  groupId: null,
  trigger: { type: 'cron', config: { expression: '*/5 * * * *', timezone: 'UTC' }, jitterMs: 0 },
  input: { type: 'static', config: { format: 'none' } },
  target: { type: 'http', config: { method: 'POST', url: 'https://' } },
  notifications: [],
  policy: {},
};

export const toSpec = ({
  version,
  ...v
}: JobFormValues): JobCreateInput & { expectedVersion?: number } => ({
  name: v.name,
  description: v.description,
  tags: v.tags,
  enabled: v.enabled,
  groupId: v.groupId,
  trigger: v.trigger,
  input: v.input,
  target: v.target,
  notifications: v.notifications,
  policy: v.policy,
  ...(version !== undefined && { expectedVersion: version }),
});

export const configIssuesFor = (
  errors: Record<string, ReactNode>,
  prefix: string,
): ConfigIssueDto[] =>
  Object.entries(errors).flatMap(([path, message]) =>
    path.startsWith(`${prefix}.config`) && typeof message === 'string'
      ? [{ path: path.slice(`${prefix}.config`.length).replace(/^\./, ''), message }]
      : [],
  );

export const fieldError = (errors: Record<string, ReactNode>, path: string): string | undefined => {
  const message = errors[path];

  return typeof message === 'string' ? message : undefined;
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Stack className="ct-panel" p="lg" spacing="md">
      <div>
        <Text weight={650}>{title}</Text>
        {hint && (
          <Text size="sm" color="dimmed">
            {hint}
          </Text>
        )}
      </div>
      {children}
    </Stack>
  );
}

const withPlaceholderName = (spec: JobCreateInput): JobCreateInput => ({
  ...spec,
  name: spec.name.trim() || 'Untitled job',
});

function SchedulePreview({ spec }: { spec: JobCreateInput }) {
  const [debounced] = useDebouncedValue(withPlaceholderName(spec), 400);
  const preview = useQuery({
    queryKey: ['jobs', 'validate', debounced],
    queryFn: () => client.jobs.validate(debounced),
    retry: false,
  });
  if (preview.isError) {
    const issues = configIssues(preview.error);

    return (
      <Alert color="red" icon={<IconAlertCircle size={18} />} title="Fix these before saving">
        {issues.length > 0 ? (
          <List size="sm">
            {issues.map((i) => (
              <List.Item key={i.path}>
                <b>{i.path}</b>: {i.message}
              </List.Item>
            ))}
          </List>
        ) : (
          errorMessage(preview.error)
        )}
      </Alert>
    );
  }
  if (!preview.data) {
    return (
      <Text color="dimmed" size="sm">
        Checking schedule…
      </Text>
    );
  }

  return (
    <Stack spacing="xs">
      <Text weight={600}>{preview.data.description}</Text>
      {preview.data.nextFireTimes.length === 0 ? (
        <Text size="sm" color="dimmed">
          This schedule will not fire again.
        </Text>
      ) : (
        <List size="sm" spacing={2}>
          {preview.data.nextFireTimes.map((t) => (
            <List.Item key={t}>{dateTime(t)}</List.Item>
          ))}
        </List>
      )}
      {preview.data.lint.map((l) => (
        <Alert
          key={l.message}
          p="xs"
          icon={<IconInfoCircle size={16} />}
          color={l.severity === 'error' ? 'red' : l.severity === 'warning' ? 'orange' : 'gray'}
        >
          <Text size="sm">{l.message}</Text>
        </Alert>
      ))}
    </Stack>
  );
}

export function JobFormFields({ form }: { form: JobForm }) {
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list({}),
    staleTime: 300_000,
  });
  const byKind = useMemo(() => {
    const all = providers.data ?? [];
    const of = (kind: ProviderDto['kind']) => all.filter((p) => p.kind === kind);

    return {
      trigger: of('trigger'),
      input: of('input'),
      target: of('target'),
      notifier: of('notifier'),
    };
  }, [providers.data]);
  const groups = useQuery({
    queryKey: ['groups', 'all'],
    queryFn: () => client.groups.list({ limit: 200 }),
    staleTime: 60_000,
  });
  const { values, errors } = form;
  const group = groups.data?.items.find((g) => g.id === values.groupId);
  const spec = useMemo(() => toSpec(values), [values]);
  const num =
    (path: Parameters<JobForm['setFieldValue']>[0], fallback: number | undefined) =>
    (v: number | undefined) =>
      form.setFieldValue(path, v ?? fallback);

  return (
    <Stack spacing="lg">
      <Section title="Basics">
        <SimpleGrid cols={2} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
          <TextInput label="Name" required {...form.getInputProps('name')} />
          <MultiSelect
            label="Tags"
            data={values.tags}
            value={values.tags}
            searchable
            creatable
            getCreateLabel={(q) => `Add “${q}”`}
            onCreate={(q) => q}
            onChange={(tags) => form.setFieldValue('tags', tags)}
            placeholder="Type to add"
          />
        </SimpleGrid>
        <Select
          label="Group"
          description="Groups supply default policies, notifications and rate limits."
          placeholder="No group"
          clearable
          searchable
          data={(groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }))}
          value={values.groupId}
          onChange={(id) =>
            form.setFieldValue('groupId', groups.data?.items.find((g) => g.id === id)?.id ?? null)
          }
        />
        <Textarea label="Description" autosize minRows={2} {...form.getInputProps('description')} />
        <Switch label="Enabled" {...form.getInputProps('enabled', { type: 'checkbox' })} />
      </Section>

      <SimpleGrid cols={2} spacing="lg" breakpoints={[{ maxWidth: 'md', cols: 1 }]}>
        <Section title="When it runs">
          <ProviderConfigForm
            label="Trigger"
            providers={byKind.trigger}
            type={values.trigger.type}
            config={values.trigger.config}
            configIssues={configIssuesFor(errors, 'trigger')}
            onTypeChange={(type) =>
              form.setFieldValue('trigger', { ...values.trigger, type, config: {} })
            }
            onConfigChange={(config) => form.setFieldValue('trigger.config', config)}
          />
          <NumberInput
            label="Random delay (ms)"
            description="Spreads load: each run starts up to this much later, never past the next run."
            min={0}
            value={values.trigger.jitterMs}
            onChange={num('trigger.jitterMs', 0)}
          />
        </Section>
        <Section
          title="Upcoming runs"
          hint="Calculated by the server from the settings on this page."
        >
          <SchedulePreview spec={spec} />
        </Section>
      </SimpleGrid>

      <Section title="What it sends" hint="The payload passed to the target on each run.">
        <ProviderConfigForm
          label="Payload"
          providers={byKind.input}
          type={values.input.type}
          config={values.input.config}
          configIssues={configIssuesFor(errors, 'input')}
          onTypeChange={(type) => form.setFieldValue('input', { type, config: {} })}
          onConfigChange={(config) => form.setFieldValue('input.config', config)}
        />
      </Section>

      <Section
        title="Where it goes"
        hint="Pick a saved connection to reuse its address and credentials, or reference secrets as {{secret:NAME}} instead of pasting them."
      >
        <TargetPicker
          providers={byKind.target}
          value={values.target}
          configIssues={configIssuesFor(errors, 'target')}
          connectionError={fieldError(errors, 'target.connection.key')}
          endpointError={fieldError(errors, 'target.connection.endpoint')}
          onChange={(target) => form.setFieldValue('target', target)}
        />
      </Section>

      <Section
        title="Notifications"
        hint="Delivered through a retried outbox. Webhooks carry an Idempotency-Key header."
      >
        <NotificationRulesEditor
          rules={values.notifications}
          providers={byKind.notifier}
          issuesFor={(i) => configIssuesFor(errors, `notifications.${i}.notifier`)}
          onChange={(rules) => form.setFieldValue('notifications', rules)}
        />
      </Section>

      <Section
        title="Reliability"
        hint="How runs are retried, overlapped, caught up and held to service levels."
      >
        <PolicyFields
          policy={values.policy}
          inherited={group?.defaultPolicy}
          inheritedFrom={group ? `the ${group.name} group` : undefined}
          onChange={(policy) => form.setFieldValue('policy', policy)}
        />
      </Section>
    </Stack>
  );
}
