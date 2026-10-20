import { ActionIcon, Button, Group, MultiSelect, Stack, Text } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { ReactNode } from 'react';

import type { JobDto, ProviderDto } from '../lib/api';
import { configIssuesFor, fieldError } from '../lib/errors';
import { ConnectedProviderPicker } from './ConnectedProviderPicker';

export type NotificationRuleDto = JobDto['notifications'][number];
type EventDto = NotificationRuleDto['on'][number];

const EVENTS: readonly { value: EventDto; label: string }[] = [
  { value: 'success', label: 'Succeeded' },
  { value: 'failure', label: 'Attempt failed, will retry' },
  { value: 'permanent_failure', label: 'Failed after all attempts' },
  { value: 'late', label: 'Late (SLA breached)' },
];

const toEvents = (values: readonly string[]): EventDto[] =>
  EVENTS.filter((e) => values.includes(e.value)).map((e) => e.value);

interface Props {
  readonly rules: readonly NotificationRuleDto[];
  readonly providers: readonly ProviderDto[];
  readonly errors: Record<string, ReactNode>;
  readonly path: string;
  readonly onChange: (rules: NotificationRuleDto[]) => void;
}

export function NotificationRulesEditor({ rules, providers, errors, path, onChange }: Props) {
  const replace = (index: number, rule: NotificationRuleDto) =>
    onChange(rules.map((r, i) => (i === index ? rule : r)));
  const firstType = providers[0]?.type ?? 'webhook';

  return (
    <Stack spacing="md">
      {rules.length === 0 && (
        <Text size="sm" color="dimmed">
          No notifications. Add one to hear about failures, successes or late runs.
        </Text>
      )}
      {rules.map((rule, index) => {
        const notifierPath = `${path}.${index}.notifier`;

        return (
          <Stack key={index} spacing="sm" className="ct-subpanel" p="md">
            <Group position="apart" align="flex-end" noWrap>
              <MultiSelect
                label="When"
                style={{ flex: 1 }}
                data={[...EVENTS]}
                value={rule.on}
                onChange={(values) => replace(index, { ...rule, on: toEvents(values) })}
              />
              <ActionIcon
                aria-label="Remove notification"
                color="red"
                variant="subtle"
                size="lg"
                onClick={() => onChange(rules.filter((_, i) => i !== index))}
              >
                <IconTrash size={18} />
              </ActionIcon>
            </Group>
            <ConnectedProviderPicker
              kind="notifier"
              providers={providers}
              value={rule.notifier}
              configIssues={configIssuesFor(errors, notifierPath)}
              connectionError={fieldError(errors, `${notifierPath}.connection.key`)}
              endpointError={fieldError(errors, `${notifierPath}.connection.endpoint`)}
              onChange={(notifier) => replace(index, { ...rule, notifier })}
            />
          </Stack>
        );
      })}
      <Group>
        <Button
          variant="light"
          leftIcon={<IconPlus size={16} />}
          onClick={() =>
            onChange([
              ...rules,
              { on: ['permanent_failure'], notifier: { type: firstType, config: {} } },
            ])
          }
        >
          Add notification
        </Button>
      </Group>
    </Stack>
  );
}
