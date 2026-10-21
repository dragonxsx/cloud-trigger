import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  MediaQuery,
  Menu,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useLogout, useWarnAboutChange } from '@refinedev/core';
import { useThemedLayoutContext } from '@refinedev/mantine';
import {
  IconApi,
  IconCheck,
  IconChevronDown,
  IconDeviceDesktop,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLogout,
  IconMenu2,
  IconMoon,
  IconSun,
  IconUserCircle,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

import { SCOPE_DESCRIPTIONS, accessLevel, useIdentity } from '../lib/access';
import { type ColorSchemePreference, useColorSchemePreference } from '../lib/color-scheme';
import { HEADER_HEIGHT } from './AppSider';
import { BrandTitle } from './Brand';
import { confirmed } from './confirm';
import { LiveIndicator } from './LiveIndicator';

function SiderToggle() {
  const { siderCollapsed, setSiderCollapsed, mobileSiderOpen, setMobileSiderOpen } =
    useThemedLayoutContext();

  return (
    <>
      <MediaQuery smallerThan="md" styles={{ display: 'none' }}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          onClick={() => setSiderCollapsed(!siderCollapsed)}
          aria-label={siderCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!siderCollapsed}
        >
          {siderCollapsed ? (
            <IconLayoutSidebarLeftExpand size={20} />
          ) : (
            <IconLayoutSidebarLeftCollapse size={20} />
          )}
        </ActionIcon>
      </MediaQuery>
      <MediaQuery largerThan="md" styles={{ display: 'none' }}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          onClick={() => setMobileSiderOpen(!mobileSiderOpen)}
          aria-label="Open navigation"
          aria-expanded={mobileSiderOpen}
        >
          <IconMenu2 size={20} />
        </ActionIcon>
      </MediaQuery>
    </>
  );
}

const SCHEME_OPTIONS: readonly {
  value: ColorSchemePreference;
  label: string;
  icon: ReactNode;
}[] = [
  { value: 'system', label: 'System', icon: <IconDeviceDesktop size={16} /> },
  { value: 'light', label: 'Light', icon: <IconSun size={16} /> },
  { value: 'dark', label: 'Dark', icon: <IconMoon size={16} /> },
];

function ThemeMenu() {
  const { preference, setPreference } = useColorSchemePreference();
  const current = SCHEME_OPTIONS.find((o) => o.value === preference) ?? SCHEME_OPTIONS[0];

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          size="lg"
          aria-label={`Color theme: ${current?.label ?? 'System'}`}
        >
          {current?.icon}
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Color theme</Menu.Label>
        {SCHEME_OPTIONS.map((option) => (
          <Menu.Item
            key={option.value}
            icon={option.icon}
            rightSection={option.value === preference ? <IconCheck size={14} aria-hidden /> : null}
            onClick={() => setPreference(option.value)}
          >
            {option.label}
            {option.value === preference && <span className="ct-sr-only"> (selected)</span>}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

function AccountMenu() {
  const { identity } = useIdentity();
  const location = useLocation();
  const { mutate: logout } = useLogout();
  const { warnWhen, setWarnWhen } = useWarnAboutChange();

  if (identity?.via === 'anonymous') {
    return (
      <Button component={Link} to="/login" size="xs" variant="light">
        Viewing as guest · Sign in
      </Button>
    );
  }

  const level = identity ? accessLevel(identity.scopes) : undefined;
  const signOut = async () => {
    if (warnWhen) {
      const leave = await confirmed({
        title: 'Sign out with unsaved changes?',
        message: 'Your unsaved changes on this page will be lost.',
        confirmLabel: 'Sign out',
        cancelLabel: 'Stay',
      });
      if (!leave) {
        return;
      }
      setWarnWhen(false);
    }
    logout();
  };

  return (
    <Menu position="bottom-end" withinPortal width={280}>
      <Menu.Target>
        <UnstyledButton
          aria-label={
            identity
              ? `Account: ${identity.name}${level === 'Read-only' ? ' (read-only)' : ''}`
              : 'Account'
          }
          sx={(theme) => ({
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 8px',
            borderRadius: theme.radius.sm,
            background:
              location.pathname === '/account'
                ? (theme.fn.variant({ variant: 'light', color: theme.primaryColor }).background ??
                  'transparent')
                : 'transparent',
            '&:hover': {
              background:
                theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],
            },
          })}
        >
          <IconUserCircle size={20} />
          <MediaQuery smallerThan="sm" styles={{ display: 'none' }}>
            <Text size="sm" weight={600} sx={{ maxWidth: 160 }} truncate>
              {identity?.name ?? ''}
            </Text>
          </MediaQuery>
          {level === 'Read-only' && (
            <MediaQuery smallerThan="sm" styles={{ display: 'none' }}>
              <Badge size="xs" color="gray" variant="outline" tt="none">
                Read-only
              </Badge>
            </MediaQuery>
          )}
          <MediaQuery smallerThan="xs" styles={{ display: 'none' }}>
            <IconChevronDown size={14} />
          </MediaQuery>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {identity && (
          <Box px="sm" py={6}>
            <Text size="sm" weight={600} truncate>
              {identity.name}
            </Text>
            <Text size="xs" color="dimmed">
              {level}
            </Text>
            {level === 'Read-only' && (
              <Text size="xs" color="dimmed" mt={4}>
                {SCOPE_DESCRIPTIONS.read} Ask an admin if you need to make changes.
              </Text>
            )}
          </Box>
        )}
        <Menu.Divider />
        <Menu.Item component={Link} to="/account" icon={<IconUserCircle size={16} />}>
          Your account
        </Menu.Item>
        <Menu.Item
          color="red"
          icon={<IconLogout size={16} />}
          onClick={() => {
            void signOut();
          }}
        >
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export function AppHeader() {
  return (
    <Box
      component="header"
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 150,
        height: HEADER_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '0 12px',
        borderBottom: '1px solid var(--ct-line)',
        background: 'var(--ct-surface)',
      }}
    >
      <Group spacing="xs" noWrap sx={{ minWidth: 0, flexShrink: 1 }}>
        <SiderToggle />
        <MediaQuery largerThan="md" styles={{ display: 'none' }}>
          <Box sx={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
            <BrandTitle collapsed={false} />
          </Box>
        </MediaQuery>
      </Group>
      <Group spacing={4} noWrap sx={{ flexShrink: 0 }}>
        <LiveIndicator />
        <Tooltip label="API reference (opens in a new tab)">
          <ActionIcon
            component="a"
            href="/docs"
            target="_blank"
            rel="noreferrer"
            variant="subtle"
            size="lg"
            aria-label="API reference (opens in a new tab)"
          >
            <IconApi size={18} />
          </ActionIcon>
        </Tooltip>
        <ThemeMenu />
        <AccountMenu />
      </Group>
    </Box>
  );
}
