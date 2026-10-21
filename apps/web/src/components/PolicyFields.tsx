import { type JobPolicy, effectivePolicy } from '@cloud-trigger/core';
import { Group, NumberInput, Select, SimpleGrid, Stack, Text } from '@mantine/core';
import { useState } from 'react';

import type { JobDto } from '../lib/api';
import { duration } from '../lib/format';

export type PolicyPatchDto = JobDto['policy'];

const OVERLAP = [
  { value: 'forbid', label: 'Skip the new run' },
  { value: 'allow', label: 'Run in parallel' },
  { value: 'replace', label: 'Cancel the running one' },
  { value: 'buffer_one', label: 'Queue one, skip the rest' },
] as const;
const MISFIRE = [
  { value: 'run_once', label: 'Run once to catch up' },
  { value: 'run_all', label: 'Run every missed time' },
  { value: 'skip', label: 'Skip missed times' },
] as const;
const BACKOFF = [
  { value: 'exponential', label: 'Exponential' },
  { value: 'fixed', label: 'Fixed' },
] as const;

const pick = <T extends string>(
  options: readonly { value: T }[],
  v: string | null,
): T | undefined => options.find((o) => o.value === v)?.value;
const labelOf = (options: readonly { value: string; label: string }[], v: string) =>
  options.find((o) => o.value === v)?.label ?? v;

type Section = 'retry' | 'misfire' | 'sla' | 'history';

const compact = <T extends object>(value: T): T | undefined =>
  Object.values(value).some((v) => v !== undefined) ? value : undefined;

export const withPolicyValue = <S extends Section, K extends keyof NonNullable<PolicyPatchDto[S]>>(
  policy: PolicyPatchDto,
  section: S,
  key: K,
  value: NonNullable<PolicyPatchDto[S]>[K] | undefined,
): PolicyPatchDto => ({
  ...policy,
  [section]: compact({ ...policy[section], [key]: value }),
});

interface Props {
  readonly policy: PolicyPatchDto;
  readonly inherited?: PolicyPatchDto | undefined;
  readonly inheritedFrom?: string | undefined;
  readonly onChange: (policy: PolicyPatchDto) => void;
  readonly showSla?: boolean;
}

const placeholderFor = (value: number | undefined) =>
  value === undefined ? 'Not set' : value.toLocaleString();

const UNITS = [
  { value: 'ms', label: 'ms', factor: 1 },
  { value: 's', label: 'sec', factor: 1000 },
  { value: 'min', label: 'min', factor: 60_000 },
  { value: 'h', label: 'hours', factor: 3_600_000 },
  { value: 'd', label: 'days', factor: 86_400_000 },
] as const;
type Unit = (typeof UNITS)[number];
const MS: Unit = UNITS[0];

const unitFor = (ms: number | undefined): Unit =>
  ms === undefined || ms === 0
    ? MS
    : (UNITS.toReversed().find((u) => ms % u.factor === 0 && ms / u.factor >= 1) ?? MS);

const LABEL_ORDER: ('label' | 'input' | 'description' | 'error')[] = [
  'label',
  'input',
  'description',
  'error',
];

interface DurationInputProps {
  readonly label: string;
  readonly description?: string;
  readonly min: number;
  readonly value: number | undefined;
  readonly inherited: number | undefined;
  readonly onChange: (ms: number | undefined) => void;
}

function DurationInput({
  label,
  description,
  min,
  value,
  inherited,
  onChange,
}: DurationInputProps) {
  const [unit, setUnit] = useState<Unit>(() => unitFor(value ?? inherited));
  const shown = value === undefined ? undefined : value / unit.factor;
  const hint = value === undefined ? undefined : `= ${duration(value)}`;
  const parts = [description, hint].filter((part) => part !== undefined);
  const joined = parts.length === 0 ? undefined : parts.join(' ');

  return (
    <Group noWrap spacing={4} align="flex-start">
      <NumberInput
        label={label}
        style={{ flex: 1 }}
        min={Math.max(min / unit.factor, 0)}
        precision={unit.factor === 1 ? 0 : 3}
        removeTrailingZeros
        placeholder={inherited === undefined ? 'Not set' : duration(inherited)}
        inputWrapperOrder={LABEL_ORDER}
        {...(joined === undefined ? {} : { description: joined })}
        value={shown}
        onChange={(v) => onChange(v === undefined ? undefined : Math.round(v * unit.factor))}
      />
      <Select
        aria-label={`${label} unit`}
        mt={25}
        style={{ width: 88 }}
        data={UNITS.map((u) => ({ value: u.value, label: u.label }))}
        value={unit.value}
        onChange={(v) => setUnit(UNITS.find((u) => u.value === v) ?? MS)}
      />
    </Group>
  );
}

export function PolicyFields({
  policy,
  inherited,
  inheritedFrom,
  onChange,
  showSla = true,
}: Props) {
  const base: JobPolicy = effectivePolicy(inherited);
  const set = <K extends keyof PolicyPatchDto>(key: K, value: PolicyPatchDto[K]) =>
    onChange({ ...policy, [key]: value });
  const inheritHint = inheritedFrom ? `Inherits from ${inheritedFrom}` : 'Uses the default';

  return (
    <Stack spacing="md">
      <Text size="xs" color="dimmed">
        Leave a field empty to inherit it. {inheritHint}, shown in grey.
      </Text>
      <SimpleGrid
        cols={3}
        breakpoints={[
          { maxWidth: 'md', cols: 2 },
          { maxWidth: 'sm', cols: 1 },
        ]}
      >
        <DurationInput
          label="Timeout"
          min={100}
          inherited={base.timeoutMs}
          value={policy.timeoutMs}
          onChange={(v) => set('timeoutMs', v)}
        />
        <NumberInput
          label="Attempts"
          description="1 means no retries"
          inputWrapperOrder={LABEL_ORDER}
          min={1}
          max={100}
          placeholder={placeholderFor(base.retry.maxAttempts)}
          value={policy.retry?.maxAttempts}
          onChange={(v) => onChange(withPolicyValue(policy, 'retry', 'maxAttempts', v))}
        />
        <Select
          label="Retry backoff"
          data={[...BACKOFF]}
          clearable
          placeholder={labelOf(BACKOFF, base.retry.backoff)}
          value={policy.retry?.backoff ?? null}
          onChange={(v) => onChange(withPolicyValue(policy, 'retry', 'backoff', pick(BACKOFF, v)))}
        />
        <DurationInput
          label="First retry delay"
          min={0}
          inherited={base.retry.delayMs}
          value={policy.retry?.delayMs}
          onChange={(v) => onChange(withPolicyValue(policy, 'retry', 'delayMs', v))}
        />
        <Select
          label="If the previous run is still going"
          data={[...OVERLAP]}
          clearable
          placeholder={labelOf(OVERLAP, base.overlap)}
          value={policy.overlap ?? null}
          onChange={(v) => set('overlap', pick(OVERLAP, v))}
        />
        <Select
          label="After downtime"
          data={[...MISFIRE]}
          clearable
          placeholder={labelOf(MISFIRE, base.misfire.mode)}
          value={policy.misfire?.mode ?? null}
          onChange={(v) => onChange(withPolicyValue(policy, 'misfire', 'mode', pick(MISFIRE, v)))}
        />
        <DurationInput
          label="Late tolerance"
          description="Later than this counts as missed."
          min={0}
          inherited={base.misfire.graceMs}
          value={policy.misfire?.graceMs}
          onChange={(v) => onChange(withPolicyValue(policy, 'misfire', 'graceMs', v))}
        />
        <NumberInput
          label="Pause after failures in a row"
          description="If nothing sets it, the job never pauses itself."
          inputWrapperOrder={LABEL_ORDER}
          min={1}
          placeholder={placeholderFor(base.pauseAfterConsecutiveFailures)}
          value={policy.pauseAfterConsecutiveFailures}
          onChange={(v) => set('pauseAfterConsecutiveFailures', v)}
        />
      </SimpleGrid>
      {showSla && (
        <>
          <Text weight={600} size="sm">
            Service levels
          </Text>
          <Text size="xs" color="dimmed">
            Breaches mark runs and the job as late and send late notifications.
          </Text>
          <SimpleGrid cols={3} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
            <DurationInput
              label="Must start within"
              description="After its scheduled time."
              min={1}
              inherited={base.sla.maxStartDelayMs}
              value={policy.sla?.maxStartDelayMs}
              onChange={(v) => onChange(withPolicyValue(policy, 'sla', 'maxStartDelayMs', v))}
            />
            <DurationInput
              label="Must finish within"
              description="Of starting; the run keeps going."
              min={1}
              inherited={base.sla.maxDurationMs}
              value={policy.sla?.maxDurationMs}
              onChange={(v) => onChange(withPolicyValue(policy, 'sla', 'maxDurationMs', v))}
            />
            <DurationInput
              label="Must succeed every"
              description="Job-level, since the last success."
              min={1}
              inherited={base.sla.maxSinceLastSuccessMs}
              value={policy.sla?.maxSinceLastSuccessMs}
              onChange={(v) => onChange(withPolicyValue(policy, 'sla', 'maxSinceLastSuccessMs', v))}
            />
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}
