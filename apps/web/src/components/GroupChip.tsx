import { Anchor, Badge } from '@mantine/core';
import { useNavigation } from '@refinedev/core';
import { Link } from 'react-router';

import type { GroupDto } from '../lib/api';

export const GROUP_SWATCHES = [
  '#6b5bd2',
  '#0f8b8d',
  '#b4237a',
  '#8a5a2b',
  '#44508c',
  '#6b7a1f',
  '#6b7280',
] as const;

export function GroupChip({ group }: { group: Pick<GroupDto, 'id' | 'name' | 'color'> }) {
  const { showUrl } = useNavigation();

  return (
    <Anchor component={Link} to={showUrl('groups', group.id)} underline={false}>
      <Badge
        variant="outline"
        radius="sm"
        size="sm"
        leftSection={
          <span
            aria-hidden
            style={{
              display: 'block',
              width: 8,
              height: 8,
              borderRadius: 2,
              background: group.color,
            }}
          />
        }
        styles={{
          root: {
            textTransform: 'none',
            fontWeight: 600,
            color: 'var(--ct-ink)',
            borderColor: `color-mix(in srgb, ${group.color} 55%, var(--ct-line))`,
            background: `color-mix(in srgb, ${group.color} 8%, transparent)`,
          },
        }}
      >
        {group.name}
      </Badge>
    </Anchor>
  );
}
