import { Select } from '@mantine/core';
import type { ReactNode } from 'react';

import { environmentLabel, useEnvironments } from '../lib/environments';

interface Props {
  readonly label?: string;
  readonly description?: string;
  readonly placeholder: string;
  readonly value: string | null;
  readonly onChange: (environment: string | null) => void;
  readonly error?: ReactNode;
  readonly clearable?: boolean;
  readonly exclude?: readonly string[];
}

export function EnvironmentSelect({
  label = 'Environment',
  description,
  placeholder,
  value,
  onChange,
  error,
  clearable = true,
  exclude = [],
}: Props) {
  const environments = useEnvironments();
  const data = (environments.data ?? [])
    .filter((environment) => environment.key === value || !exclude.includes(environment.key))
    .map((environment) => ({ value: environment.key, label: environmentLabel(environment) }));

  return (
    <Select
      label={label}
      description={description}
      placeholder={placeholder}
      data={data}
      value={value}
      onChange={onChange}
      clearable={clearable}
      searchable
      nothingFound="No environments yet. Add them in Settings → Environments."
      error={error}
    />
  );
}
