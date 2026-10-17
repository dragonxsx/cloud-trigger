import {
  ActionIcon,
  ColorSchemeProvider,
  Global,
  MantineProvider,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { useColorScheme, useLocalStorage } from '@mantine/hooks';
import { NotificationsProvider } from '@mantine/notifications';
import { Authenticated, Refine } from '@refinedev/core';
import {
  ErrorComponent,
  ThemedLayout,
  ThemedSider,
  useNotificationProvider,
} from '@refinedev/mantine';
import routerProvider, {
  CatchAllNavigate,
  NavigateToResource,
  UnsavedChangesNotifier,
} from '@refinedev/react-router';
import {
  IconActivity,
  IconApi,
  IconCalendarTime,
  IconLayoutDashboard,
  IconMoon,
  IconSun,
} from '@tabler/icons-react';
import { useEffect } from 'react';
import { BrowserRouter, Outlet, Route, Routes } from 'react-router';

import { BrandTitle } from './components/Brand';
import { Dashboard } from './pages/Dashboard';
import { JobCreate } from './pages/jobs/create';
import { JobEdit } from './pages/jobs/edit';
import { JobList } from './pages/jobs/list';
import { JobShow } from './pages/jobs/show';
import { Login } from './pages/Login';
import { RunList } from './pages/runs/list';
import { RunShow } from './pages/runs/show';
import { accessControlProvider, authProvider } from './providers/auth-provider';
import { dataProvider } from './providers/data-provider';
import { createSharedRunStreamLiveProvider } from './providers/live-provider';
import { buildTheme } from './theme';

const liveProvider = createSharedRunStreamLiveProvider();

const Sider = () => (
  <ThemedSider
    Title={BrandTitle}
    render={({ items, logout }) => (
      <>
        {items}
        {logout}
      </>
    )}
  />
);

function HeaderActions() {
  const scheme = useMantineColorScheme();
  const dark = scheme.colorScheme === 'dark';

  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        justifyContent: 'flex-end',
        padding: '8px 16px',
        borderBottom: '1px solid var(--ct-line)',
        background: 'var(--ct-surface)',
      }}
    >
      <Tooltip label="API reference">
        <ActionIcon
          component="a"
          href="/docs"
          target="_blank"
          variant="subtle"
          aria-label="API reference"
        >
          <IconApi size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={dark ? 'Light theme' : 'Dark theme'}>
        <ActionIcon
          variant="subtle"
          onClick={() => scheme.toggleColorScheme()}
          aria-label="Toggle color scheme"
        >
          {dark ? <IconSun size={18} /> : <IconMoon size={18} />}
        </ActionIcon>
      </Tooltip>
    </div>
  );
}

export function App() {
  const preferred = useColorScheme();
  const [colorScheme, setColorScheme] = useLocalStorage<'light' | 'dark'>({
    key: 'cloud-trigger.color-scheme',
    defaultValue: preferred,
  });
  const toggle = () => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark');
  useEffect(() => {
    document.documentElement.dataset['theme'] = colorScheme;
  }, [colorScheme]);

  return (
    <BrowserRouter>
      <ColorSchemeProvider colorScheme={colorScheme} toggleColorScheme={toggle}>
        <MantineProvider theme={buildTheme(colorScheme)} withNormalizeCSS withGlobalStyles>
          <Global styles={{ body: { WebkitFontSmoothing: 'antialiased' } }} />
          <NotificationsProvider position="top-right">
            <Refine
              dataProvider={dataProvider}
              liveProvider={liveProvider}
              authProvider={authProvider}
              accessControlProvider={accessControlProvider}
              routerProvider={routerProvider}
              // oxlint-disable-next-line react/hooks -- Refine calls the hook inside its provider
              notificationProvider={useNotificationProvider}
              resources={[
                {
                  name: 'dashboard',
                  list: '/',
                  meta: { label: 'Dashboard', icon: <IconLayoutDashboard size={18} /> },
                },
                {
                  name: 'jobs',
                  list: '/jobs',
                  create: '/jobs/create',
                  edit: '/jobs/edit/:id',
                  show: '/jobs/show/:id',
                  meta: { label: 'Jobs', icon: <IconCalendarTime size={18} />, canDelete: true },
                },
                {
                  name: 'runs',
                  list: '/runs',
                  show: '/runs/show/:id',
                  meta: { label: 'Runs', icon: <IconActivity size={18} /> },
                },
              ]}
              options={{
                liveMode: 'auto',
                syncWithLocation: true,
                warnWhenUnsavedChanges: true,
                disableTelemetry: true,
                title: { text: 'Cloud Trigger' },
              }}
            >
              <Routes>
                <Route
                  element={
                    <Authenticated key="app" fallback={<CatchAllNavigate to="/login" />}>
                      <ThemedLayout Title={BrandTitle} Sider={Sider} Header={HeaderActions}>
                        <Outlet />
                      </ThemedLayout>
                    </Authenticated>
                  }
                >
                  <Route index element={<Dashboard />} />
                  <Route path="/jobs">
                    <Route index element={<JobList />} />
                    <Route path="create" element={<JobCreate />} />
                    <Route path="edit/:id" element={<JobEdit />} />
                    <Route path="show/:id" element={<JobShow />} />
                  </Route>
                  <Route path="/runs">
                    <Route index element={<RunList />} />
                    <Route path="show/:id" element={<RunShow />} />
                  </Route>
                  <Route path="*" element={<ErrorComponent />} />
                </Route>
                <Route
                  element={
                    <Authenticated key="auth" fallback={<Outlet />}>
                      <NavigateToResource resource="dashboard" />
                    </Authenticated>
                  }
                >
                  <Route path="/login" element={<Login />} />
                </Route>
              </Routes>
              <UnsavedChangesNotifier />
            </Refine>
          </NotificationsProvider>
        </MantineProvider>
      </ColorSchemeProvider>
    </BrowserRouter>
  );
}
