import { NodeKey, topologicalOrder } from '@cloud-trigger/core';
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
  Title,
} from '@mantine/core';
import type { FormErrors, UseFormReturnType } from '@mantine/form';
import { hideNotification, showNotification } from '@mantine/notifications';
import { useList } from '@refinedev/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { type ReactNode, useMemo, useState } from 'react';

import { ConnectedProviderPicker } from '../../components/ConnectedProviderPicker';
import { EnvironmentSelect } from '../../components/EnvironmentSelect';
import { ProviderConfigForm } from '../../components/ProviderConfigForm';
import { WorkflowGraph } from '../../components/WorkflowGraph';
import type { JobDto, ProviderDto, WorkflowSpecDto } from '../../lib/api';
import { configIssuesFor, fieldError } from '../../lib/errors';
import { countOf } from '../../lib/format';
import { useProviders } from '../../lib/providers';

type FormNode = WorkflowSpecDto['nodes'][number];
type EdgeOutcome = 'succeeded' | 'failed' | 'any';
type FormEdge = { from: string; to: string; on: EdgeOutcome };
type Schedule = NonNullable<WorkflowSpecDto['schedule']>;

export interface WorkflowFormValues {
  name: string;
  description: string;
  enabled: boolean;
  environment: string | null;
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

const OUTCOMES: { value: EdgeOutcome; label: string }[] = [
  { value: 'succeeded', label: 'succeeds' },
  { value: 'failed', label: 'fails' },
  { value: 'any', label: 'finishes either way' },
];

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
  environment: null,
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
  environment: values.environment,
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

const keyIssue = (key: string, nodes: readonly FormNode[], index: number): string | undefined => {
  if (key === '') {
    return 'Enter a key';
  }
  if (!NodeKey.safeParse(key).success) {
    return 'Use lowercase letters, digits, "-" and "_", starting with a letter or digit';
  }
  if (nodes.some((node, i) => i !== index && node.key === key)) {
    return `Another step already uses "${key}"`;
  }

  return undefined;
};

const pairTaken = (edges: readonly FormEdge[], from: string, to: string, except: number) =>
  edges.some((edge, i) => i !== except && edge.from === from && edge.to === to);

export function validateWorkflow(values: WorkflowFormValues): FormErrors {
  const errors: FormErrors = {};
  if (values.name.trim() === '') {
    errors['name'] = 'Enter a name';
  }
  const keys = new Set(values.nodes.map((node) => node.key));
  values.nodes.forEach((node, index) => {
    const issue = keyIssue(node.key, values.nodes, index);
    if (issue !== undefined) {
      errors[`nodes.${index}.key`] = issue;
    }
    if (node.kind === 'job' && node.jobId === '') {
      errors[`nodes.${index}.jobId`] = 'Pick a job';
    }
  });
  values.edges.forEach((edge, index) => {
    if (!keys.has(edge.from)) {
      errors[`edges.${index}.from`] = 'Pick a step';
    }
    if (!keys.has(edge.to)) {
      errors[`edges.${index}.to`] = 'Pick a step';
    } else if (edge.from === edge.to) {
      errors[`edges.${index}.to`] = "A step can't run after itself";
    } else if (pairTaken(values.edges, edge.from, edge.to, index)) {
      errors[`edges.${index}.to`] = `Another edge already links ${edge.from} to ${edge.to}`;
    }
  });
  const graph = {
    nodes: values.nodes.map((node) => ({ key: node.key, kind: 'approval' as const })),
    edges: values.edges,
  };
  if (Object.keys(errors).length === 0 && topologicalOrder(graph) === null) {
    errors['edges'] = 'The edges form a loop. Remove one so every step can start.';
  }

  return errors;
}

const stepAnchor = (index: number) => `workflow-step-${index}`;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Stack className="ct-panel" p="lg" spacing="sm">
      <div>
        <Title order={2} size="h4">
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

function StepKeyInput({
  form,
  index,
  node,
}: {
  form: WorkflowForm;
  index: number;
  node: FormNode;
}) {
  const [draft, setDraft] = useState({ base: node.key, value: node.key });
  const value = draft.base === node.key ? draft.value : node.key;
  const issue = value === node.key ? undefined : keyIssue(value, form.values.nodes, index);
  const commit = () => {
    if (value === node.key) {
      return;
    }
    if (issue !== undefined) {
      setDraft({ base: node.key, value: node.key });
      showNotification({ color: 'orange', title: `Kept the key "${node.key}"`, message: issue });

      return;
    }
    const rename = (key: string) => (key === node.key ? value : key);
    form.setFieldValue(
      'nodes',
      form.values.nodes.map((n, i) => (i === index ? { ...n, key: value } : n)),
    );
    form.setFieldValue(
      'edges',
      form.values.edges.map((edge) => ({ ...edge, from: rename(edge.from), to: rename(edge.to) })),
    );
    form.clearFieldError(`nodes.${index}.key`);
  };

  return (
    <TextInput
      id={`${stepAnchor(index)}-key`}
      label="Key"
      description="Edges follow when you rename"
      required
      w={180}
      value={value}
      error={issue ?? fieldError(form.errors, `nodes.${index}.key`)}
      onChange={(event) => setDraft({ base: node.key, value: event.currentTarget.value })}
      onBlur={commit}
    />
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
  const remove = () => {
    const snapshot = { nodes: form.values.nodes, edges: form.values.edges };
    const notificationId = `workflow-step-removed-${node.key}`;
    form.setFieldValue(
      'nodes',
      snapshot.nodes.filter((_, i) => i !== index),
    );
    const keptEdges = snapshot.edges.filter(
      (edge) => edge.from !== node.key && edge.to !== node.key,
    );
    const removedEdges = snapshot.edges.length - keptEdges.length;
    form.setFieldValue('edges', keptEdges);
    showNotification({
      id: notificationId,
      title: `Removed step ${node.key}`,
      autoClose: 10_000,
      message: (
        <Group position="apart" noWrap>
          <Text size="sm">
            {removedEdges === 0
              ? 'You can undo this.'
              : `${countOf(removedEdges, 'connected edge')} removed too.`}
          </Text>
          <Button
            size="xs"
            variant="subtle"
            compact
            onClick={() => {
              form.setFieldValue('nodes', snapshot.nodes);
              form.setFieldValue('edges', snapshot.edges);
              hideNotification(notificationId);
            }}
          >
            Undo
          </Button>
        </Group>
      ),
    });
  };

  return (
    <Paper withBorder p="md" radius="md" id={stepAnchor(index)}>
      <Stack spacing="sm">
        <Group position="apart" align="flex-start" noWrap>
          <Group spacing="sm" align="flex-start">
            <StepKeyInput form={form} index={index} node={node} />
            <TextInput label="Label" w={220} {...form.getInputProps(`${path}.label`)} />
            <Stack spacing={4}>
              <Text size="sm" weight={500} id={`${stepAnchor(index)}-kind`}>
                Kind
              </Text>
              <SegmentedControl
                aria-labelledby={`${stepAnchor(index)}-kind`}
                value={node.kind}
                onChange={setKind}
                data={[
                  { value: 'inline', label: 'Inline job' },
                  { value: 'job', label: 'Existing job' },
                  { value: 'approval', label: 'Approval' },
                ]}
              />
            </Stack>
          </Group>
          <ActionIcon
            color="red"
            variant="subtle"
            size="lg"
            aria-label={`Remove step ${node.key}`}
            onClick={remove}
          >
            <IconTrash size={18} />
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

function EdgeRow({
  form,
  index,
  edge,
  keys,
}: {
  form: WorkflowForm;
  index: number;
  edge: FormEdge;
  keys: readonly string[];
}) {
  const { edges } = form.values;
  const fromOptions = keys.map((key) => ({
    value: key,
    label: key,
    disabled: key === edge.to || pairTaken(edges, key, edge.to, index),
  }));
  const toOptions = keys.map((key) => ({
    value: key,
    label: key,
    disabled: key === edge.from || pairTaken(edges, edge.from, key, index),
  }));
  const rowError = fieldError(form.errors, `edges.${index}`);

  return (
    <Stack spacing={4} className="ct-subpanel" p="sm">
      <Group spacing="xs" align="flex-start">
        <Text size="sm" mt={8}>
          Run
        </Text>
        <Select
          aria-label={`Edge ${index + 1}: step to run`}
          data={toOptions}
          w={170}
          {...form.getInputProps(`edges.${index}.to`)}
        />
        <Text size="sm" mt={8}>
          after
        </Text>
        <Select
          aria-label={`Edge ${index + 1}: upstream step`}
          data={fromOptions}
          w={170}
          {...form.getInputProps(`edges.${index}.from`)}
        />
        <Select
          aria-label={`Edge ${index + 1}: outcome`}
          w={180}
          data={OUTCOMES}
          {...form.getInputProps(`edges.${index}.on`)}
        />
        <ActionIcon
          color="red"
          variant="subtle"
          size="lg"
          aria-label={`Remove edge from ${edge.from} to ${edge.to}`}
          onClick={() => form.removeListItem('edges', index)}
        >
          <IconTrash size={18} />
        </ActionIcon>
      </Group>
      {rowError && (
        <Text color="red" size="sm">
          {rowError}
        </Text>
      )}
    </Stack>
  );
}

const unusedPair = (keys: readonly string[], edges: readonly FormEdge[]): FormEdge | undefined => {
  for (const [i, from] of keys.entries()) {
    for (const to of keys.slice(i + 1)) {
      if (!pairTaken(edges, from, to, -1)) {
        return { from, to, on: 'succeeded' };
      }
    }
  }

  return undefined;
};

const focusStep = (index: number) => {
  document
    .getElementById(stepAnchor(index))
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById(`${stepAnchor(index)}-key`)?.focus({ preventScroll: true });
};

export function WorkflowFormFields({ form }: { form: WorkflowForm }) {
  const providers = useProviders();
  const jobs = useList<JobDto>({
    resource: 'jobs',
    pagination: { mode: 'off' },
    queryOptions: { staleTime: 30_000 },
  });
  const byKind = useMemo(() => {
    const all = providers.data ?? [];

    return {
      input: all.filter((p) => p.kind === 'input'),
      target: all.filter((p) => p.kind === 'target'),
      schedule: all.filter((p) => p.kind === 'trigger' && TIME_TRIGGERS.has(p.type)),
    };
  }, [providers.data]);
  const jobOptions = jobs.result.data
    .filter((job) => job.workflowId === null)
    .map((job) => ({ value: job.id, label: job.name }));
  const { values } = form;
  const keys = values.nodes.map((node) => node.key);
  const nextEdge = unusedPair(keys, values.edges);

  return (
    <Stack spacing="lg">
      <Section title="Basics">
        <TextInput label="Name" required {...form.getInputProps('name')} />
        <Textarea label="Description" autosize minRows={2} {...form.getInputProps('description')} />
        <EnvironmentSelect
          description="Inline steps that set no environment run with this environment's connection overlays."
          placeholder="Base connection configs"
          value={values.environment}
          onChange={(environment) => form.setFieldValue('environment', environment)}
          error={fieldError(form.errors, 'environment')}
        />
        <Switch label="Enabled" {...form.getInputProps('enabled', { type: 'checkbox' })} />
      </Section>

      <Section
        title="Graph"
        hint="Steps run when every incoming edge's condition is met. Click a step to edit it."
      >
        <WorkflowGraph
          nodes={values.nodes}
          edges={values.edges}
          onNodeClick={(key) => {
            const index = values.nodes.findIndex((node) => node.key === key);
            if (index >= 0) {
              focusStep(index);
            }
          }}
        />
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
        hint="Each edge makes a step wait for another step to finish with the chosen outcome."
      >
        {values.edges.length === 0 && (
          <Text size="sm" color="dimmed">
            No edges. Without edges every step starts at once.
          </Text>
        )}
        {values.edges.map((edge, index) => (
          <EdgeRow key={index} form={form} index={index} edge={edge} keys={keys} />
        ))}
        <Group spacing="sm">
          <Button
            variant="default"
            leftIcon={<IconPlus size={16} />}
            disabled={nextEdge === undefined}
            onClick={() => {
              if (nextEdge !== undefined) {
                form.insertListItem('edges', nextEdge);
              }
            }}
          >
            Add edge
          </Button>
          {nextEdge === undefined && (
            <Text size="sm" color="dimmed">
              {values.nodes.length < 2
                ? 'Add a second step to link steps.'
                : 'Every pair of steps is already linked.'}
            </Text>
          )}
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
