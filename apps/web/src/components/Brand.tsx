import { Center, Group, Stack, Text } from '@mantine/core';
import type { RefineLayoutThemedTitleProps } from '@refinedev/mantine';
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
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

export function AuthShell({
  width = 380,
  children,
}: {
  readonly width?: number;
  readonly children: ReactNode;
}) {
  return (
    <Center component="main" mih="100vh" p="md" style={{ background: 'var(--ct-paper)' }}>
      <Stack w="100%" maw={width} miw={0} className="ct-panel" p="xl" spacing="md">
        {children}
      </Stack>
    </Center>
  );
}

export function useFocusOnMount<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return ref;
}
