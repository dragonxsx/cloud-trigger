import { ActionIcon, Button, Group, MultiSelect, Stack, Text } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';

import type { JobDto, ProviderDto } from '../lib/api';
import type { ConfigIssueDto } from '../lib/errors';
import { ProviderConfigForm } from './ProviderConfigForm';

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
  readonly issuesFor: (index: number) => readonly ConfigIssueDto[];
  readonly onChange: (rules: NotificationRuleDto[]) => void;
}

export function NotificationRulesEditor({ rules, providers, issuesFor, onChange }: Props) {
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
      {rules.map((rule, index) => (
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
          <ProviderConfigForm
            label="Send to"
            providers={providers}
            type={rule.notifier.type}
            config={rule.notifier.config}
            configIssues={issuesFor(index)}
            onTypeChange={(type) => replace(index, { ...rule, notifier: { type, config: {} } })}
            onConfigChange={(config) =>
              replace(index, { ...rule, notifier: { ...rule.notifier, config } })
            }
          />
        </Stack>
      ))}
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
