import { Group, Text } from '@mantine/core';
import type { RefineLayoutThemedTitleProps } from '@refinedev/mantine';
import { Link } from 'react-router';

export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#2a5bd7" />
      <path
        d="M7 20h5l3-9 3 13 3-8h4"
        stroke="white"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandTitle({ collapsed }: RefineLayoutThemedTitleProps) {
  return (
    <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
      <Group spacing={8} noWrap>
        <BrandMark />
        {!collapsed && (
          <Text weight={700} size="md">
            Cloud Trigger
          </Text>
        )}
      </Group>
    </Link>
  );
}
