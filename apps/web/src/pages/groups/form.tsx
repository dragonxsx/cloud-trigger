import {
  ColorInput,
  NumberInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import type { FormErrors, UseFormReturnType } from '@mantine/form';
import { IconColorPicker } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { EnvironmentSelect } from '../../components/EnvironmentSelect';
import { GROUP_SWATCHES } from '../../components/GroupChip';
import { NotificationRulesEditor } from '../../components/NotificationRulesEditor';
import { PolicyFields } from '../../components/PolicyFields';
import { type GroupDto, client } from '../../lib/api';

type GroupSpecDto = Parameters<typeof client.groups.create>[0];

export type GroupFormValues = Pick<
  GroupDto,
  | 'name'
  | 'color'
  | 'description'
  | 'environment'
  | 'defaultPolicy'
  | 'defaultNotifications'
  | 'rateLimit'
> & { version?: number };

export type GroupForm = UseFormReturnType<
  GroupFormValues,
  (values: GroupFormValues) => GroupSpecDto & { expectedVersion?: number }
>;

export const blankGroup: GroupFormValues = {
  name: '',
  color: GROUP_SWATCHES[0],
  description: '',
  environment: null,
  defaultPolicy: {},
  defaultNotifications: [],
  rateLimit: null,
};

export const toGroupSpec = ({
  version,
  ...v
}: GroupFormValues): GroupSpecDto & { expectedVersion?: number } => ({
  name: v.name,
  color: v.color,
  description: v.description,
  environment: v.environment,
  defaultPolicy: v.defaultPolicy,
  defaultNotifications: v.defaultNotifications,
  rateLimit: v.rateLimit,
  ...(version !== undefined && { expectedVersion: version }),
});

export function validateGroup(values: GroupFormValues): FormErrors {
  const errors: FormErrors = {};
  if (values.name.trim() === '') {
    errors['name'] = 'Enter a name';
  }
  values.defaultNotifications.forEach((rule, index) => {
    if (rule.on.length === 0) {
      errors[`defaultNotifications.${index}.on`] = 'Pick at least one event';
    }
  });

  return errors;
}

const rateLimitOf = (perSecond: number | undefined, maxConcurrent: number | undefined) =>
  perSecond === undefined && maxConcurrent === undefined
    ? null
    : {
        ...(perSecond !== undefined && { perSecond }),
        ...(maxConcurrent !== undefined && { maxConcurrent }),
      };

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Stack className="ct-panel" p="lg" spacing="md">
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

export function GroupFormFields({ form }: { form: GroupForm }) {
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.providers.list({}),
    staleTime: 300_000,
  });
  const notifiers = (providers.data ?? []).filter((p) => p.kind === 'notifier');
  const { values, errors } = form;
  const perSecond = values.rateLimit?.perSecond;
  const maxConcurrent = values.rateLimit?.maxConcurrent;

  return (
    <Stack spacing="lg">
      <Section title="Basics">
        <SimpleGrid cols={2} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
          <TextInput label="Name" required {...form.getInputProps('name')} />
          <ColorInput
            label="Colour"
            format="hex"
            swatches={[...GROUP_SWATCHES]}
            swatchesPerRow={7}
            eyeDropperIcon={<IconColorPicker size={16} title="Pick a colour from the screen" />}
            {...form.getInputProps('color')}
          />
        </SimpleGrid>
        <EnvironmentSelect
          description="Member jobs that set no environment run with this environment's connection overlays."
          placeholder="Base connection configs"
          value={values.environment}
          onChange={(environment) => form.setFieldValue('environment', environment)}
          error={form.errors['environment']}
        />
        <Textarea label="Description" autosize minRows={2} {...form.getInputProps('description')} />
      </Section>

      <Section
        title="Flow control"
        hint="Shared by every job in the group, across all worker replicas. Throttled runs wait without using an attempt."
      >
        <SimpleGrid cols={2} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
          <NumberInput
            label="Runs started per second"
            placeholder="Unlimited"
            min={0.01}
            precision={2}
            step={1}
            value={perSecond}
            onChange={(v) => form.setFieldValue('rateLimit', rateLimitOf(v, maxConcurrent))}
          />
          <NumberInput
            label="Runs at once"
            placeholder="Unlimited"
            min={1}
            value={maxConcurrent}
            onChange={(v) => form.setFieldValue('rateLimit', rateLimitOf(perSecond, v))}
          />
        </SimpleGrid>
      </Section>

      <Section
        title="Default policy"
        hint="Member jobs inherit these settings unless they set their own."
      >
        <PolicyFields
          policy={values.defaultPolicy}
          onChange={(policy) => form.setFieldValue('defaultPolicy', policy)}
        />
      </Section>

      <Section
        title="Default notifications"
        hint="Sent for every member job, in addition to the job's own notifications."
      >
        <NotificationRulesEditor
          rules={values.defaultNotifications}
          providers={notifiers}
          errors={errors}
          path="defaultNotifications"
          onChange={(rules) => form.setFieldValue('defaultNotifications', rules)}
        />
      </Section>
    </Stack>
  );
}
