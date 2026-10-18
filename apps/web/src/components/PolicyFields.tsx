import { type JobPolicy, effectivePolicy } from '@cloud-trigger/core';
import { NumberInput, Select, SimpleGrid, Stack, Text } from '@mantine/core';

import type { JobDto } from '../lib/api';

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
        <NumberInput
          label="Timeout (ms)"
          min={100}
          placeholder={placeholderFor(base.timeoutMs)}
          value={policy.timeoutMs}
          onChange={(v) => set('timeoutMs', v)}
        />
        <NumberInput
          label="Attempts"
          description="1 means no retries"
          min={1}
          max={100}
          placeholder={placeholderFor(base.retry.maxAttempts)}
          value={policy.retry?.maxAttempts}
          onChange={(v) => onChange(withPolicyValue(policy, 'retry', 'maxAttempts', v))}
        />
        <SimpleGrid cols={2} spacing="xs">
          <Select
            label="Backoff"
            data={[...BACKOFF]}
            clearable
            placeholder={labelOf(BACKOFF, base.retry.backoff)}
            value={policy.retry?.backoff ?? null}
            onChange={(v) =>
              onChange(withPolicyValue(policy, 'retry', 'backoff', pick(BACKOFF, v)))
            }
          />
          <NumberInput
            label="First delay (ms)"
            min={0}
            placeholder={placeholderFor(base.retry.delayMs)}
            value={policy.retry?.delayMs}
            onChange={(v) => onChange(withPolicyValue(policy, 'retry', 'delayMs', v))}
          />
        </SimpleGrid>
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
        <NumberInput
          label="Late tolerance (ms)"
          description="Later than this counts as missed"
          min={0}
          placeholder={placeholderFor(base.misfire.graceMs)}
          value={policy.misfire?.graceMs}
          onChange={(v) => onChange(withPolicyValue(policy, 'misfire', 'graceMs', v))}
        />
        <NumberInput
          label="Pause after failures in a row"
          description="Empty inherits; unset means never pause"
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
            <NumberInput
              label="Must start within (ms)"
              description="After its scheduled time"
              min={1}
              placeholder={placeholderFor(base.sla.maxStartDelayMs)}
              value={policy.sla?.maxStartDelayMs}
              onChange={(v) => onChange(withPolicyValue(policy, 'sla', 'maxStartDelayMs', v))}
            />
            <NumberInput
              label="Must finish within (ms)"
              description="Of starting; the run keeps going"
              min={1}
              placeholder={placeholderFor(base.sla.maxDurationMs)}
              value={policy.sla?.maxDurationMs}
              onChange={(v) => onChange(withPolicyValue(policy, 'sla', 'maxDurationMs', v))}
            />
            <NumberInput
              label="Must succeed every (ms)"
              description="Job-level, since the last success"
              min={1}
              placeholder={placeholderFor(base.sla.maxSinceLastSuccessMs)}
              value={policy.sla?.maxSinceLastSuccessMs}
              onChange={(v) => onChange(withPolicyValue(policy, 'sla', 'maxSinceLastSuccessMs', v))}
            />
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}
