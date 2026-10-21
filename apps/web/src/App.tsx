import { ColorSchemeProvider, Global, MantineProvider } from '@mantine/core';
import { useColorScheme, useLocalStorage } from '@mantine/hooks';
import { ModalsProvider } from '@mantine/modals';
import { NotificationsProvider } from '@mantine/notifications';
import { Authenticated, type IResourceItem, Refine } from '@refinedev/core';
import routerProvider, {
  CatchAllNavigate,
  DocumentTitleHandler,
  UnsavedChangesNotifier,
} from '@refinedev/react-router';
import {
  IconActivity,
  IconCalendarTime,
  IconFolders,
  IconHierarchy2,
  IconKey,
  IconLayoutDashboard,
  IconPlugConnected,
  IconSettings,
  IconShieldLock,
  IconStack2,
  IconUsers,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, Suspense, useLayoutEffect, useMemo } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router';

import { ActivityProgress } from './components/ActivityProgress';
import { AppLayout } from './components/AppLayout';
import { NotFoundPage, PageLoader } from './components/PageState';
import { RequireAccess } from './components/RequireAccess';
import { APP_TITLE, pageTitle } from './components/usePageTitle';
import { client } from './lib/api';
import {
  type ColorScheme,
  type ColorSchemePreference,
  ColorSchemePreferenceContext,
  THEME_STORAGE_KEY,
  applyColorScheme,
  parseStoredScheme,
} from './lib/color-scheme';
import { shouldRetryQuery } from './lib/errors';
import { lazyNamed } from './lib/lazy';
import { accessControlProvider, authProvider } from './providers/auth-provider';
import { dataProvider } from './providers/data-provider';
import { createSharedRunStreamLiveProvider } from './providers/live-provider';
import { useAppNotificationProvider } from './providers/notification-provider';
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

const SYSTEM_PREFERENCE: ColorSchemePreference = 'system';

const QUERY_CLIENT_CONFIG = { defaultOptions: { queries: { retry: shouldRetryQuery } } };

const PATH_TITLES: Readonly<Record<string, string>> = {
  '/account': 'Your account',
  '/login': 'Sign in',
  '/setup': 'Set up',
  '/auth/callback': 'Signing in',
};

const singular = (label: string): string => (label.endsWith('s') ? label.slice(0, -1) : label);

function documentTitle({
  resource,
  action,
  pathname,
}: {
  resource?: IResourceItem;
  action?: string;
  pathname?: string;
}): string {
  const fromPath = pathname === undefined ? undefined : PATH_TITLES[pathname];
  if (fromPath !== undefined) {
    return pageTitle(fromPath);
  }
  const label = resource?.meta?.label;
  if (label === undefined) {
    return APP_TITLE;
  }
  const one = singular(label);
  switch (action) {
    case 'create':
      return pageTitle(`New ${one.toLowerCase()}`, label);
    case 'edit':
      return pageTitle(`Edit ${one.toLowerCase()}`, label);
    case 'show':
      return pageTitle(one, label);
    default:
      return pageTitle(label);
  }
}

const guarded = (
  resource: string,
  action: string,
  back: { to: string; label: string },
  element: ReactNode,
) => (
  <RequireAccess resource={resource} action={action} backTo={back.to} backLabel={back.label}>
    {element}
  </RequireAccess>
);

const JOBS_BACK = { to: '/jobs', label: 'Back to jobs' };
const WORKFLOWS_BACK = { to: '/workflows', label: 'Back to workflows' };
const GROUPS_BACK = { to: '/groups', label: 'Back to groups' };
const CONNECTIONS_BACK = { to: '/connections', label: 'Back to connections' };
const HOME_BACK = { to: '/', label: 'Back to dashboard' };

export function App() {
  const system = useColorScheme(undefined, { getInitialValueInEffect: false });
  const [override, setOverride, clearOverride] = useLocalStorage<ColorScheme | undefined>({
    key: THEME_STORAGE_KEY,
    defaultValue: undefined,
    getInitialValueInEffect: false,
    deserialize: parseStoredScheme,
  });
  const colorScheme = override ?? system;
  const preference = useMemo(
    () => ({
      preference: override ?? SYSTEM_PREFERENCE,
      setPreference: (next: ColorSchemePreference) => {
        if (next === 'system') {
          clearOverride();
        } else {
          setOverride(next);
        }
      },
    }),
    [override, clearOverride, setOverride],
  );
  const toggle = (value?: ColorScheme) => {
    setOverride(value ?? (colorScheme === 'dark' ? 'light' : 'dark'));
  };
  useLayoutEffect(() => {
    applyColorScheme(colorScheme);
  }, [colorScheme]);
  const notificationProvider = useAppNotificationProvider();

  return (
    <BrowserRouter useTransitions={false}>
      <ColorSchemePreferenceContext.Provider value={preference}>
        <ColorSchemeProvider colorScheme={colorScheme} toggleColorScheme={toggle}>
          <MantineProvider theme={buildTheme(colorScheme)} withNormalizeCSS withGlobalStyles>
            <Global styles={{ body: { WebkitFontSmoothing: 'antialiased' } }} />
            <ModalsProvider>
              <NotificationsProvider position="top-right">
                <Refine
                  dataProvider={dataProvider}
                  liveProvider={liveProvider}
                  authProvider={authProvider}
                  accessControlProvider={accessControlProvider}
                  routerProvider={routerProvider}
                  notificationProvider={notificationProvider}
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
                      meta: {
                        label: 'Jobs',
                        icon: <IconCalendarTime size={18} />,
                        canDelete: true,
                      },
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
                      meta: {
                        label: 'Workflows',
                        icon: <IconHierarchy2 size={18} />,
                        canDelete: true,
                      },
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
                    title: { text: APP_TITLE },
                    reactQuery: { clientConfig: QUERY_CLIENT_CONFIG },
                  }}
                >
                  <ActivityProgress />
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
                            <AppLayout>
                              <Suspense fallback={<PageLoader />}>
                                <Outlet />
                              </Suspense>
                            </AppLayout>
                          </Authenticated>
                        }
                      >
                        <Route index element={<Dashboard />} />
                        <Route path="/jobs">
                          <Route index element={<JobList />} />
                          <Route
                            path="create"
                            element={guarded('jobs', 'create', JOBS_BACK, <JobCreate />)}
                          />
                          <Route
                            path="edit/:id"
                            element={guarded('jobs', 'edit', JOBS_BACK, <JobEdit />)}
                          />
                          <Route path="show/:id" element={<JobShow />} />
                        </Route>
                        <Route path="/runs">
                          <Route index element={<RunList />} />
                          <Route path="show/:id" element={<RunShow />} />
                        </Route>
                        <Route path="/workflows">
                          <Route index element={<WorkflowList />} />
                          <Route
                            path="create"
                            element={guarded(
                              'workflows',
                              'create',
                              WORKFLOWS_BACK,
                              <WorkflowCreate />,
                            )}
                          />
                          <Route
                            path="edit/:id"
                            element={guarded('workflows', 'edit', WORKFLOWS_BACK, <WorkflowEdit />)}
                          />
                          <Route path="show/:id" element={<WorkflowShow />} />
                          <Route path="runs/:id" element={<WorkflowRunShow />} />
                        </Route>
                        <Route path="/groups">
                          <Route index element={<GroupList />} />
                          <Route
                            path="create"
                            element={guarded('groups', 'create', GROUPS_BACK, <GroupCreate />)}
                          />
                          <Route
                            path="edit/:id"
                            element={guarded('groups', 'edit', GROUPS_BACK, <GroupEdit />)}
                          />
                          <Route path="show/:id" element={<GroupShow />} />
                        </Route>
                        <Route path="/connections">
                          <Route index element={<ConnectionList />} />
                          <Route
                            path="create"
                            element={guarded(
                              'connections',
                              'create',
                              CONNECTIONS_BACK,
                              <ConnectionCreate />,
                            )}
                          />
                          <Route
                            path="edit/:id"
                            element={guarded(
                              'connections',
                              'edit',
                              CONNECTIONS_BACK,
                              <ConnectionEdit />,
                            )}
                          />
                          <Route path="show/:id" element={<ConnectionShow />} />
                        </Route>
                        <Route path="/settings">
                          <Route index element={<Navigate to="environments" replace />} />
                          <Route path="environments" element={<EnvironmentList />} />
                          <Route
                            path="auth"
                            element={guarded(
                              'auth-settings',
                              'list',
                              HOME_BACK,
                              <AuthSettingsPage />,
                            )}
                          />
                          <Route
                            path="users"
                            element={guarded('users', 'list', HOME_BACK, <UserList />)}
                          />
                          <Route
                            path="api-keys"
                            element={guarded('api-keys', 'list', HOME_BACK, <ApiKeyList />)}
                          />
                        </Route>
                        <Route path="/account" element={<AccountPage />} />
                        <Route path="*" element={<NotFoundPage />} />
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
                  <DocumentTitleHandler handler={documentTitle} />
                </Refine>
              </NotificationsProvider>
            </ModalsProvider>
          </MantineProvider>
        </ColorSchemeProvider>
      </ColorSchemePreferenceContext.Provider>
    </BrowserRouter>
  );
}
