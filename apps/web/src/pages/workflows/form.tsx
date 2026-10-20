import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useMemo } from 'react';

import { ConnectedProviderPicker } from '../../components/ConnectedProviderPicker';
import { ProviderConfigForm } from '../../components/ProviderConfigForm';
import { WorkflowGraph } from '../../components/WorkflowGraph';
import { type ProviderDto, type WorkflowSpecDto, client } from '../../lib/api';
import { configIssuesFor, fieldError } from '../../lib/errors';

type FormNode = WorkflowSpecDto['nodes'][number];
type FormEdge = { from: string; to: string; on: 'succeeded' | 'failed' | 'any' };
type Schedule = NonNullable<WorkflowSpecDto['schedule']>;

export interface WorkflowFormValues {
  name: string;
  description: string;
  enabled: boolean;
  nodes: FormNode[];
  edges: FormEdge[];
  schedule: Schedule | null;
  version?: number;
}

export type WorkflowForm = UseFormReturnType<
  WorkflowFormValues,
  (values: WorkflowFormValues) => WorkflowSpecDto & { expectedVersion?: number }
>;

const TIME_TRIGGERS = new Set(['cron', 'interval', 'rrule', 'once']);

const blankInline = (key: string): FormNode => ({
  key,
  kind: 'inline',
  job: {
    input: { type: 'static', config: { format: 'none' } },
    target: { type: 'http', config: { url: 'https://' } },
  },
});

export const blankWorkflow: WorkflowFormValues = {
  name: '',
  description: '',
  enabled: true,
  nodes: [blankInline('first')],
  edges: [],
  schedule: null,
};

export const toWorkflowSpec = ({
  version,
  ...values
}: WorkflowFormValues): WorkflowSpecDto & { expectedVersion?: number } => ({
  name: values.name,
  description: values.description,
  enabled: values.enabled,
  nodes: values.nodes,
  edges: values.edges,
  schedule: values.schedule,
  ...(version !== undefined && { expectedVersion: version }),
});

const nextKey = (nodes: readonly FormNode[]): string => {
  let index = nodes.length + 1;
  while (nodes.some((node) => node.key === `step-${index}`)) {
    index++;
  }

  return `step-${index}`;
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Stack className="ct-panel" p="lg" spacing="sm">
      <div>
        <Text weight={600}>{title}</Text>
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

function NodeEditor({
  form,
  index,
  node,
  providers,
  jobs,
}: {
  form: WorkflowForm;
  index: number;
  node: FormNode;
  providers: { input: ProviderDto[]; target: ProviderDto[] };
  jobs: { value: string; label: string }[];
}) {
  const path = `nodes.${index}`;
  const replace = (next: FormNode) => form.setFieldValue(`nodes.${index}`, next);
  const setKind = (kind: string) => {
    if (kind === 'approval') {
      replace({ key: node.key, kind: 'approval', ...(node.label && { label: node.label }) });
    } else if (kind === 'job') {
      replace({
        key: node.key,
        kind: 'job',
        jobId: jobs[0]?.value ?? '',
        ...(node.label && { label: node.label }),
      });
    } else {
      replace({ ...blankInline(node.key), ...(node.label && { label: node.label }) });
    }
  };

  return (
    <Paper withBorder p="md" radius="md">
      <Stack spacing="sm">
        <Group position="apart" align="flex-end">
          <Group spacing="sm" align="flex-end">
            <TextInput label="Key" required w={160} {...form.getInputProps(`${path}.key`)} />
            <TextInput label="Label" w={220} {...form.getInputProps(`${path}.label`)} />
            <SegmentedControl
              value={node.kind}
              onChange={setKind}
              data={[
                { value: 'inline', label: 'Inline job' },
                { value: 'job', label: 'Existing job' },
                { value: 'approval', label: 'Approval' },
              ]}
            />
          </Group>
          <ActionIcon
            color="red"
            variant="subtle"
            aria-label={`Remove ${node.key}`}
            onClick={() => {
              form.setFieldValue(
                'nodes',
                form.values.nodes.filter((_, i) => i !== index),
              );
              form.setFieldValue(
                'edges',
                form.values.edges.filter((edge) => edge.from !== node.key && edge.to !== node.key),
              );
            }}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
        {node.kind === 'job' && (
          <Select label="Job" searchable data={jobs} {...form.getInputProps(`${path}.jobId`)} />
        )}
        {node.kind === 'approval' && (
          <NumberInput
            label="Timeout (minutes)"
            description="Fail the gate when nobody approves in time. Empty waits forever."
            min={1}
            value={node.timeoutMs === undefined ? undefined : node.timeoutMs / 60_000}
            onChange={(minutes) =>
              replace(
                minutes === undefined
                  ? { key: node.key, kind: 'approval', ...(node.label && { label: node.label }) }
                  : { ...node, timeoutMs: minutes * 60_000 },
              )
            }
          />
        )}
        {node.kind === 'inline' && (
          <SimpleGrid cols={2} spacing="md" breakpoints={[{ maxWidth: 'md', cols: 1 }]}>
            <ConnectedProviderPicker
              kind="target"
              providers={providers.target}
              value={node.job.target}
              configIssues={configIssuesFor(form.errors, `${path}.job.target`)}
              connectionError={fieldError(form.errors, `${path}.job.target.connection.key`)}
              endpointError={fieldError(form.errors, `${path}.job.target.connection.endpoint`)}
              onChange={(target) => form.setFieldValue(`${path}.job.target`, target)}
            />
            <ProviderConfigForm
              label="Payload"
              providers={providers.input}
              type={node.job.input?.type ?? 'static'}
              config={node.job.input?.config ?? { format: 'none' }}
              configIssues={configIssuesFor(form.errors, `${path}.job.input`)}
              onTypeChange={(type) => form.setFieldValue(`${path}.job.input`, { type, config: {} })}
              onConfigChange={(config) => form.setFieldValue(`${path}.job.input.config`, config)}
            />
          </SimpleGrid>
        )}
      </Stack>
    </Paper>
  );
}

export function WorkflowFormFields({ form }: { form: WorkflowForm }) {
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list({}),
    staleTime: 300_000,
  });
  const jobs = useQuery({
    queryKey: ['jobs', 'all'],
    queryFn: () => client.jobs.list({ limit: 200 }),
    staleTime: 30_000,
  });
  const byKind = useMemo(() => {
    const all = providers.data ?? [];

    return {
      input: all.filter((p) => p.kind === 'input'),
      target: all.filter((p) => p.kind === 'target'),
      schedule: all.filter((p) => p.kind === 'trigger' && TIME_TRIGGERS.has(p.type)),
    };
  }, [providers.data]);
  const jobOptions = (jobs.data?.items ?? [])
    .filter((job) => job.workflowId === null)
    .map((job) => ({ value: job.id, label: job.name }));
  const { values } = form;
  const keys = values.nodes.map((node) => ({ value: node.key, label: node.key }));

  return (
    <Stack spacing="lg">
      <Section title="Basics">
        <TextInput label="Name" required {...form.getInputProps('name')} />
        <Textarea label="Description" autosize minRows={2} {...form.getInputProps('description')} />
        <Switch label="Enabled" {...form.getInputProps('enabled', { type: 'checkbox' })} />
      </Section>

      <Section title="Graph" hint="Steps run when every incoming edge's condition is met.">
        <WorkflowGraph nodes={values.nodes} edges={values.edges} height={260} />
        {typeof form.errors['edges'] === 'string' && (
          <Text color="red" size="sm">
            {form.errors['edges']}
          </Text>
        )}
      </Section>

      <Section
        title="Steps"
        hint="Inline jobs belong to this workflow. Approval gates wait for someone with write access."
      >
        {values.nodes.map((node, index) => (
          <NodeEditor
            key={index}
            form={form}
            index={index}
            node={node}
            providers={byKind}
            jobs={jobOptions}
          />
        ))}
        <Group>
          <Button
            variant="default"
            leftIcon={<IconPlus size={16} />}
            onClick={() => form.insertListItem('nodes', blankInline(nextKey(values.nodes)))}
          >
            Add step
          </Button>
        </Group>
      </Section>

      <Section
        title="Edges"
        hint="A step runs after its upstream steps finish with the chosen outcome."
      >
        {values.edges.map((edge, index) => (
          <Group key={index} spacing="sm" align="flex-end">
            <Select
              label="From"
              data={keys}
              w={180}
              {...form.getInputProps(`edges.${index}.from`)}
            />
            <Select label="To" data={keys} w={180} {...form.getInputProps(`edges.${index}.to`)} />
            <Select
              label="When"
              w={160}
              data={[
                { value: 'succeeded', label: 'succeeded' },
                { value: 'failed', label: 'failed' },
                { value: 'any', label: 'any outcome' },
              ]}
              {...form.getInputProps(`edges.${index}.on`)}
            />
            <ActionIcon
              color="red"
              variant="subtle"
              mb={4}
              aria-label="Remove edge"
              onClick={() => form.removeListItem('edges', index)}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        ))}
        <Group>
          <Button
            variant="default"
            leftIcon={<IconPlus size={16} />}
            disabled={values.nodes.length < 2}
            onClick={() =>
              form.insertListItem('edges', {
                from: values.nodes[0]?.key ?? '',
                to: values.nodes[1]?.key ?? '',
                on: 'succeeded',
              })
            }
          >
            Add edge
          </Button>
        </Group>
      </Section>

      <Section
        title="Schedule"
        hint="Optional. Workflows can always be started by hand or through the API."
      >
        <Switch
          label="Run on a schedule"
          checked={values.schedule !== null}
          onChange={(event) =>
            form.setFieldValue(
              'schedule',
              event.currentTarget.checked
                ? { type: 'cron', config: { expression: '0 9 * * 1-5' }, jitterMs: 0 }
                : null,
            )
          }
        />
        {values.schedule && (
          <ProviderConfigForm
            label="Trigger"
            providers={byKind.schedule}
            type={values.schedule.type}
            config={values.schedule.config}
            configIssues={configIssuesFor(form.errors, 'schedule')}
            onTypeChange={(type) =>
              form.setFieldValue('schedule', { type, config: {}, jitterMs: 0 })
            }
            onConfigChange={(config) => form.setFieldValue('schedule.config', config)}
          />
        )}
      </Section>
    </Stack>
  );
}
