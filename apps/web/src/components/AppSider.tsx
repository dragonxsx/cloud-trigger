import { Box, Drawer, MediaQuery, NavLink, ScrollArea, Tooltip } from '@mantine/core';
import { CanAccess, type TreeMenuItem, useMenu } from '@refinedev/core';
import { useThemedLayoutContext } from '@refinedev/mantine';
import { IconList } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { BrandTitle } from './Brand';

export const SIDER_WIDTH = 220;
export const SIDER_COLLAPSED_WIDTH = 72;
export const HEADER_HEIGHT = 64;

interface ItemProps {
  readonly item: TreeMenuItem;
  readonly selectedKey: string;
  readonly collapsed: boolean;
  readonly onNavigate: () => void;
}

const containsKey = (item: TreeMenuItem, key: string): boolean =>
  item.key === key || item.children.some((child) => containsKey(child, key));

function SiderItem({ item, selectedKey, collapsed, onNavigate }: ItemProps) {
  const isParent = item.children.length > 0;
  const active = containsKey(item, selectedKey);
  const [toggled, setToggled] = useState<boolean | undefined>(undefined);
  const opened = toggled ?? active;
  const label = item.label ?? item.name;
  const icon = item.icon ?? <IconList size={18} />;

  const link = isParent ? (
    <NavLink
      label={collapsed ? null : label}
      icon={icon}
      active={active && !opened}
      opened={opened}
      onChange={setToggled}
      aria-expanded={opened}
      aria-label={collapsed ? label : undefined}
      childrenOffset={collapsed ? 0 : 12}
      styles={navLinkStyles(collapsed)}
    >
      {item.children.map((child) => (
        <SiderItem
          key={child.key}
          item={child}
          selectedKey={selectedKey}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      ))}
    </NavLink>
  ) : (
    <NavLink
      component={Link}
      to={item.route ?? '/'}
      label={collapsed ? null : label}
      icon={icon}
      active={active}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      onClick={onNavigate}
      styles={navLinkStyles(collapsed)}
    />
  );

  return (
    <CanAccess resource={item.name} action="list" params={{ resource: item }}>
      <Tooltip label={label} position="right" withArrow disabled={!collapsed} withinPortal>
        <Box>{link}</Box>
      </Tooltip>
    </CanAccess>
  );
}

const navLinkStyles = (collapsed: boolean) => ({
  root: {
    borderRadius: 6,
    marginTop: 2,
    minHeight: 38,
    justifyContent: collapsed ? 'center' : 'flex-start',
  },
  icon: { marginRight: collapsed ? 0 : 12 },
  body: { display: collapsed ? 'none' : 'flex' },
  label: { fontWeight: 500 },
});

function SiderMenu({ collapsed, onNavigate }: { collapsed: boolean; onNavigate: () => void }) {
  const { menuItems, selectedKey } = useMenu();

  return (
    <Box component="nav" aria-label="Main" px="xs" py="xs">
      {menuItems.map((item) => (
        <SiderItem
          key={item.key}
          item={item}
          selectedKey={selectedKey}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      ))}
    </Box>
  );
}

function BrandBar({ collapsed }: { collapsed: boolean }) {
  return (
    <Box
      sx={{
        height: HEADER_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        paddingLeft: collapsed ? 0 : 18,
        borderBottom: '1px solid var(--ct-line)',
      }}
    >
      <BrandTitle collapsed={collapsed} />
    </Box>
  );
}

const noop = () => undefined;

export function AppSider() {
  const { siderCollapsed, mobileSiderOpen, setMobileSiderOpen } = useThemedLayoutContext();
  const width = siderCollapsed ? SIDER_COLLAPSED_WIDTH : SIDER_WIDTH;
  const closeMobile = () => setMobileSiderOpen(false);

  return (
    <>
      <MediaQuery largerThan="md" styles={{ display: 'none' }}>
        <Drawer
          opened={mobileSiderOpen}
          onClose={closeMobile}
          size={SIDER_WIDTH}
          zIndex={1200}
          title={<BrandTitle collapsed={false} />}
          aria-label="Navigation"
          styles={{
            drawer: { background: 'var(--ct-surface)', display: 'flex', flexDirection: 'column' },
            header: {
              height: HEADER_HEIGHT,
              margin: 0,
              padding: '0 12px 0 18px',
              borderBottom: '1px solid var(--ct-line)',
            },
            closeButton: { width: 32, height: 32 },
          }}
          closeButtonLabel="Close navigation"
        >
          <ScrollArea style={{ flex: 1 }}>
            <SiderMenu collapsed={false} onNavigate={closeMobile} />
          </ScrollArea>
        </Drawer>
      </MediaQuery>
      <MediaQuery smallerThan="md" styles={{ display: 'none' }}>
        <Box sx={{ width, flexShrink: 0, transition: 'width 200ms ease' }} />
      </MediaQuery>
      <MediaQuery smallerThan="md" styles={{ display: 'none' }}>
        <Box
          component="aside"
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            zIndex: 199,
            width,
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--ct-surface)',
            borderRight: '1px solid var(--ct-line)',
            transition: 'width 200ms ease',
            overflow: 'hidden',
          }}
        >
          <BrandBar collapsed={siderCollapsed} />
          <ScrollArea style={{ flex: 1 }}>
            <SiderMenu collapsed={siderCollapsed} onNavigate={noop} />
          </ScrollArea>
        </Box>
      </MediaQuery>
    </>
  );
}
