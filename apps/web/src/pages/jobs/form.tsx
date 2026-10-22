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
  Title,
} from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertCircle, IconInfoCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { sentenceCase } from 'change-case';
import cronstrue from 'cronstrue';
import { type ReactNode, useMemo } from 'react';
import { z } from 'zod';

import { ConnectedProviderPicker } from '../../components/ConnectedProviderPicker';
import { EnvironmentSelect } from '../../components/EnvironmentSelect';
import { NotificationRulesEditor } from '../../components/NotificationRulesEditor';
import { PolicyFields } from '../../components/PolicyFields';
import { ProviderConfigForm } from '../../components/ProviderConfigForm';
import { type JobCreateInput, type JobDto, type ProviderDto, orpc } from '../../lib/api';
import {
  type ConfigIssueDto,
  configIssues,
  configIssuesFor,
  errorMessage,
  fieldError,
} from '../../lib/errors';
import { dateTime, dateTimeWithLocal } from '../../lib/format';
import { useGroups } from '../../lib/groups';
import { useProviders } from '../../lib/providers';

export type JobFormValues = Pick<
  JobDto,
  | 'name'
  | 'description'
  | 'tags'
  | 'enabled'
  | 'groupId'
  | 'environment'
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
  environment: null,
  trigger: { type: 'cron', config: { expression: '*/5 * * * *', timezone: 'UTC' }, jitterMs: 0 },
  input: { type: 'static', config: { format: 'none' } },
  target: { type: 'http', config: { method: 'POST', url: 'https://' } },
  notifications: [],
  policy: {},
};

export const validateJob = {
  name: (name: string) => (name.trim() === '' ? 'Required' : null),
  notifications: {
    on: (on: readonly string[]) => (on.length === 0 ? 'Pick at least one event' : null),
  },
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
  environment: v.environment,
  trigger: v.trigger,
  input: v.input,
  target: v.target,
  notifications: v.notifications,
  policy: v.policy,
  ...(version !== undefined && { expectedVersion: version }),
});

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Stack className="ct-panel" p="lg" spacing="md">
      <div>
        <Title order={2} size="h5">
          {title}
        </Title>
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

export const DEFAULT_TRIGGER_ZONE = 'UTC';

const ZonedConfig = z.object({ timezone: z.string().min(1) });
const CronConfig = z.object({ expression: z.string() });
const CronError = z.string().catch('');

const CRON_PART: Record<string, string> = {
  seconds: 'Seconds',
  minutes: 'Minute',
  hours: 'Hour',
  DOM: 'Day of month',
  month: 'Month',
  DOW: 'Day of week',
  year: 'Year',
};

const cronProblem = (expression: string): string | undefined => {
  try {
    cronstrue.toString(expression);

    return undefined;
  } catch (e) {
    const text = CronError.parse(e instanceof Error ? e.message : e).replace(/^Error: /, '');
    const range = /^(\w+) part must be >= (\d+) and <= (\d+)$/.exec(text);
    if (range) {
      const [, part = '', min = '', max = ''] = range;

      return `${CRON_PART[part] ?? sentenceCase(part)} must be between ${min} and ${max}`;
    }

    return text === '' ? undefined : text;
  }
};

const issueLabel = (path: string): string => {
  const last = path.split('.').findLast((segment) => !/^\d+$/.test(segment)) ?? path;

  return last === '' ? 'Schedule' : sentenceCase(last);
};

const TRIGGER_CONFIG = 'trigger.config';

function previewIssues(error: unknown, trigger: JobCreateInput['trigger']): ConfigIssueDto[] {
  return configIssues(error).map((issue) => {
    const cron = trigger.type === 'cron' ? CronConfig.safeParse(trigger.config) : undefined;
    const specific =
      issue.path === `${TRIGGER_CONFIG}.expression` && cron?.success
        ? cronProblem(cron.data.expression)
        : undefined;

    return specific === undefined ? issue : { ...issue, message: specific };
  });
}

const triggerIssues = (issues: readonly ConfigIssueDto[]): ConfigIssueDto[] =>
  issues.flatMap((issue) =>
    issue.path.startsWith(TRIGGER_CONFIG)
      ? [{ ...issue, path: issue.path.slice(TRIGGER_CONFIG.length).replace(/^\./, '') }]
      : [],
  );

function useSchedulePreview(spec: JobCreateInput) {
  const [debounced] = useDebouncedValue(withPlaceholderName(spec), 400);

  return useQuery(orpc.jobs.validate.queryOptions({ input: debounced, retry: false }));
}

type SchedulePreviewQuery = ReturnType<typeof useSchedulePreview>;

function SchedulePreview({
  preview,
  issues,
  zone,
}: {
  preview: SchedulePreviewQuery;
  issues: readonly ConfigIssueDto[];
  zone: string | undefined;
}) {
  if (preview.isError) {
    return (
      <Alert color="red" icon={<IconAlertCircle size={18} />} title="Fix these before saving">
        {issues.length > 0 ? (
          <List size="sm">
            {issues.map((i) => (
              <List.Item key={i.path}>
                <b>{issueLabel(i.path)}</b>: {i.message}
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
            <List.Item key={t}>
              {zone === undefined ? dateTime(t) : dateTimeWithLocal(t, zone)}
            </List.Item>
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

export const triggerZone = (trigger: Pick<JobDto, 'trigger'>['trigger']): string | undefined => {
  const zoned = ZonedConfig.safeParse(trigger.config);
  if (zoned.success) {
    return zoned.data.timezone;
  }

  return trigger.type === 'cron' || trigger.type === 'rrule' ? DEFAULT_TRIGGER_ZONE : undefined;
};

export function JobFormFields({ form }: { form: JobForm }) {
  const providers = useProviders();
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
  const { groups } = useGroups();
  const { values, errors } = form;
  const group = groups.find((g) => g.id === values.groupId);
  const groupEnvironment = group?.environment ?? null;
  const spec = useMemo(() => toSpec(values), [values]);
  const preview = useSchedulePreview(spec);
  const issuesFromPreview = useMemo(
    () => (preview.isError ? previewIssues(preview.error, spec.trigger) : []),
    [preview.isError, preview.error, spec.trigger],
  );
  const savedTriggerIssues = configIssuesFor(errors, 'trigger');
  const triggerConfigIssues = [
    ...savedTriggerIssues,
    ...triggerIssues(issuesFromPreview).filter(
      (issue) => !savedTriggerIssues.some((saved) => saved.path === issue.path),
    ),
  ];
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
        <SimpleGrid cols={2} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
          <Select
            label="Group"
            description="Groups supply default policies, notifications and rate limits."
            placeholder="No group"
            clearable
            searchable
            data={groups.map((g) => ({ value: g.id, label: g.name }))}
            value={values.groupId}
            onChange={(id) =>
              form.setFieldValue('groupId', groups.find((g) => g.id === id)?.id ?? null)
            }
          />
          <EnvironmentSelect
            description="Picks the connection overlays the job runs with."
            placeholder={
              groupEnvironment ? `Inherit from group (${groupEnvironment})` : 'Inherit from group'
            }
            value={values.environment}
            onChange={(environment) => form.setFieldValue('environment', environment)}
            error={fieldError(errors, 'environment')}
          />
        </SimpleGrid>
        <Textarea label="Description" autosize minRows={2} {...form.getInputProps('description')} />
        <Switch
          label="Enabled"
          description="When off, the job never runs on its schedule. To stop it for a while, use Pause on the job page instead."
          {...form.getInputProps('enabled', { type: 'checkbox' })}
        />
      </Section>

      <SimpleGrid cols={2} spacing="lg" breakpoints={[{ maxWidth: 'md', cols: 1 }]}>
        <Section title="When it runs">
          <ConnectedProviderPicker
            kind="trigger"
            providers={byKind.trigger}
            value={values.trigger}
            configIssues={triggerConfigIssues}
            connectionError={fieldError(errors, 'trigger.connection.key')}
            endpointError={fieldError(errors, 'trigger.connection.endpoint')}
            onChange={(trigger) =>
              form.setFieldValue('trigger', { ...trigger, jitterMs: values.trigger.jitterMs })
            }
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
          <SchedulePreview
            preview={preview}
            issues={issuesFromPreview}
            zone={triggerZone(values.trigger)}
          />
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
        <ConnectedProviderPicker
          kind="target"
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
          errors={errors}
          path="notifications"
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
