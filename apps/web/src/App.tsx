import {
  ActionIcon,
  Button,
  Center,
  ColorSchemeProvider,
  Loader,
  Global,
  MantineProvider,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { useColorScheme, useLocalStorage } from '@mantine/hooks';
import { NotificationsProvider } from '@mantine/notifications';
import { Authenticated, Refine, useGetIdentity } from '@refinedev/core';
import {
  ErrorComponent,
  ThemedLayout,
  ThemedSider,
  useNotificationProvider,
} from '@refinedev/mantine';
import routerProvider, { CatchAllNavigate, UnsavedChangesNotifier } from '@refinedev/react-router';
import {
  IconActivity,
  IconApi,
  IconCalendarTime,
  IconFolders,
  IconStack2,
  IconHierarchy2,
  IconKey,
  IconLayoutDashboard,
  IconPlugConnected,
  IconMoon,
  IconSettings,
  IconShieldLock,
  IconSun,
  IconUserCircle,
  IconUsers,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from 'react-router';

import { BrandTitle } from './components/Brand';
import { client } from './lib/api';
import { lazyNamed } from './lib/lazy';
import { accessControlProvider, authProvider } from './providers/auth-provider';
import { dataProvider } from './providers/data-provider';
import { createSharedRunStreamLiveProvider } from './providers/live-provider';
import { buildTheme } from './theme';

const Dashboard = lazyNamed(() => import('./pages/Dashboard'), 'Dashboard');
const JobList = lazyNamed(() => import('./pages/jobs/list'), 'JobList');
const JobCreate = lazyNamed(() => import('./pages/jobs/create'), 'JobCreate');
const JobEdit = lazyNamed(() => import('./pages/jobs/edit'), 'JobEdit');
const JobShow = lazyNamed(() => import('./pages/jobs/show'), 'JobShow');
const RunList = lazyNamed(() => import('./pages/runs/list'), 'RunList');
const RunShow = lazyNamed(() => import('./pages/runs/show'), 'RunShow');
const GroupList = lazyNamed(() => import('./pages/groups/list'), 'GroupList');
const GroupCreate = lazyNamed(() => import('./pages/groups/create'), 'GroupCreate');
const GroupEdit = lazyNamed(() => import('./pages/groups/edit'), 'GroupEdit');
const GroupShow = lazyNamed(() => import('./pages/groups/show'), 'GroupShow');
const ConnectionList = lazyNamed(() => import('./pages/connections/list'), 'ConnectionList');
const ConnectionCreate = lazyNamed(() => import('./pages/connections/create'), 'ConnectionCreate');
const ConnectionEdit = lazyNamed(() => import('./pages/connections/edit'), 'ConnectionEdit');
const ConnectionShow = lazyNamed(() => import('./pages/connections/show'), 'ConnectionShow');
const WorkflowList = lazyNamed(() => import('./pages/workflows/list'), 'WorkflowList');
const WorkflowCreate = lazyNamed(() => import('./pages/workflows/create'), 'WorkflowCreate');
const WorkflowEdit = lazyNamed(() => import('./pages/workflows/edit'), 'WorkflowEdit');
const WorkflowShow = lazyNamed(() => import('./pages/workflows/show'), 'WorkflowShow');
const WorkflowRunShow = lazyNamed(() => import('./pages/workflows/run'), 'WorkflowRunShow');
const Login = lazyNamed(() => import('./pages/Login'), 'Login');
const AuthCallback = lazyNamed(() => import('./pages/AuthCallback'), 'AuthCallback');
const SetupWizard = lazyNamed(() => import('./pages/setup/Wizard'), 'SetupWizard');
const AuthSettingsPage = lazyNamed(() => import('./pages/settings/auth'), 'AuthSettingsPage');
const UserList = lazyNamed(() => import('./pages/settings/users'), 'UserList');
const ApiKeyList = lazyNamed(() => import('./pages/settings/api-keys'), 'ApiKeyList');
const EnvironmentList = lazyNamed(() => import('./pages/settings/environments'), 'EnvironmentList');
const AccountPage = lazyNamed(() => import('./pages/Account'), 'AccountPage');

const PageLoader = () => (
  <Center h={240}>
    <Loader size="sm" />
  </Center>
);

const liveProvider = createSharedRunStreamLiveProvider();

function SetupGate() {
  const status = useQuery({
    queryKey: ['setup', 'status'],
    queryFn: () => client.setup.status({}),
    staleTime: Infinity,
    retry: false,
  });
  if (status.isLoading) {
    return <PageLoader />;
  }
  if (status.data && status.data.stage !== 'done') {
    return <Navigate to="/setup" replace />;
  }

  return <Outlet />;
}

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
  const identity = useGetIdentity<{ via: string }>();

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
      {identity.data?.via === 'anonymous' ? (
        <Button component={Link} to="/login" size="xs" variant="light" mr="xs">
          Viewing as guest · Sign in
        </Button>
      ) : (
        <Tooltip label="Your account">
          <ActionIcon component={Link} to="/account" variant="subtle" aria-label="Your account">
            <IconUserCircle size={18} />
          </ActionIcon>
        </Tooltip>
      )}
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
                {
                  name: 'workflows',
                  list: '/workflows',
                  create: '/workflows/create',
                  edit: '/workflows/edit/:id',
                  show: '/workflows/show/:id',
                  meta: { label: 'Workflows', icon: <IconHierarchy2 size={18} />, canDelete: true },
                },
                {
                  name: 'groups',
                  list: '/groups',
                  create: '/groups/create',
                  edit: '/groups/edit/:id',
                  show: '/groups/show/:id',
                  meta: { label: 'Groups', icon: <IconFolders size={18} />, canDelete: true },
                },
                {
                  name: 'connections',
                  list: '/connections',
                  create: '/connections/create',
                  edit: '/connections/edit/:id',
                  show: '/connections/show/:id',
                  meta: {
                    label: 'Connections',
                    icon: <IconPlugConnected size={18} />,
                    canDelete: true,
                  },
                },
                {
                  name: 'settings',
                  meta: { label: 'Settings', icon: <IconSettings size={18} /> },
                },
                {
                  name: 'environments',
                  list: '/settings/environments',
                  meta: {
                    label: 'Environments',
                    parent: 'settings',
                    icon: <IconStack2 size={18} />,
                  },
                },
                {
                  name: 'auth-settings',
                  list: '/settings/auth',
                  meta: {
                    label: 'Sign-in methods',
                    parent: 'settings',
                    icon: <IconShieldLock size={18} />,
                  },
                },
                {
                  name: 'users',
                  list: '/settings/users',
                  meta: { label: 'Users', parent: 'settings', icon: <IconUsers size={18} /> },
                },
                {
                  name: 'api-keys',
                  list: '/settings/api-keys',
                  meta: { label: 'API keys', parent: 'settings', icon: <IconKey size={18} /> },
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
                  path="/setup"
                  element={
                    <Suspense fallback={<PageLoader />}>
                      <SetupWizard />
                    </Suspense>
                  }
                />
                <Route element={<SetupGate />}>
                  <Route
                    path="/auth/callback"
                    element={
                      <Suspense fallback={<PageLoader />}>
                        <AuthCallback />
                      </Suspense>
                    }
                  />
                  <Route
                    element={
                      <Authenticated key="app" fallback={<CatchAllNavigate to="/login" />}>
                        <ThemedLayout Title={BrandTitle} Sider={Sider} Header={HeaderActions}>
                          <Suspense fallback={<PageLoader />}>
                            <Outlet />
                          </Suspense>
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
                    <Route path="/workflows">
                      <Route index element={<WorkflowList />} />
                      <Route path="create" element={<WorkflowCreate />} />
                      <Route path="edit/:id" element={<WorkflowEdit />} />
                      <Route path="show/:id" element={<WorkflowShow />} />
                      <Route path="runs/:id" element={<WorkflowRunShow />} />
                    </Route>
                    <Route path="/groups">
                      <Route index element={<GroupList />} />
                      <Route path="create" element={<GroupCreate />} />
                      <Route path="edit/:id" element={<GroupEdit />} />
                      <Route path="show/:id" element={<GroupShow />} />
                    </Route>
                    <Route path="/connections">
                      <Route index element={<ConnectionList />} />
                      <Route path="create" element={<ConnectionCreate />} />
                      <Route path="edit/:id" element={<ConnectionEdit />} />
                      <Route path="show/:id" element={<ConnectionShow />} />
                    </Route>
                    <Route path="/settings">
                      <Route path="environments" element={<EnvironmentList />} />
                      <Route path="auth" element={<AuthSettingsPage />} />
                      <Route path="users" element={<UserList />} />
                      <Route path="api-keys" element={<ApiKeyList />} />
                    </Route>
                    <Route path="/account" element={<AccountPage />} />
                    <Route path="*" element={<ErrorComponent />} />
                  </Route>
                  <Route
                    path="/login"
                    element={
                      <Suspense fallback={<PageLoader />}>
                        <Login />
                      </Suspense>
                    }
                  />
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
