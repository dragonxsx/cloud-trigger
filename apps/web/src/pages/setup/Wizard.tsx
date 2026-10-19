import {
  Alert,
  Button,
  Center,
  Code,
  CopyButton,
  Group,
  Loader,
  PasswordInput,
  SegmentedControl,
  Stack,
  Stepper,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconCopy, IconRefresh } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { BrandMark } from '../../components/Brand';
import { SignInMethodsFields, blankMethods, toAuthMethods } from '../../components/SignInMethods';
import { type SetupStatusDto, client } from '../../lib/api';
import { configIssues, errorMessage } from '../../lib/errors';
import { resetAuthConfig } from '../../lib/oidc';
import { setupToken } from '../../lib/session';
import { startPasswordSession } from '../../providers/auth-provider';

type Driver = 'sqlite' | 'postgres' | 'mongo';
type DatabaseTest = Awaited<ReturnType<typeof client.setup.testDatabase>>;

const MIN_PASSWORD = 12;

function TokenStep({ onVerified }: { onVerified: (token: string) => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setChecking(true);
        client.setup
          .verifyToken({ token: token.trim() })
          .then(() => onVerified(token.trim()))
          .catch((failure: unknown) => setError(errorMessage(failure)))
          .finally(() => setChecking(false));
      }}
    >
      <Stack spacing="sm">
        <Text size="sm" color="dimmed">
          The server printed a one-time setup token in its log when it started (look for “Setup
          required”). If you set <Code>SETUP_TOKEN</Code>, use that value.
        </Text>
        <PasswordInput
          label="Setup token"
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
          {...(error ? { error } : {})}
          required
        />
        <Group position="right">
          <Button type="submit" loading={checking} disabled={token.trim() === ''}>
            Continue
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

const envText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

function DatabaseStep({
  status,
  token,
  onNext,
  onRecheck,
}: {
  status: SetupStatusDto;
  token: string;
  onNext: () => void;
  onRecheck: () => void;
}) {
  const [driver, setDriver] = useState<Driver>(status.database.driver ?? 'sqlite');
  const [mongoUri, setMongoUri] = useState('mongodb://localhost:27017/?replicaSet=rs0');
  const [mongoDb, setMongoDb] = useState('cloud_trigger');
  const [postgresUrl, setPostgresUrl] = useState(
    'postgres://user:password@localhost:5432/cloud_trigger',
  );
  const [sqlitePath, setSqlitePath] = useState('./data/cloud-trigger.db');
  const [result, setResult] = useState<DatabaseTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status.stage !== 'database') {
    return (
      <Stack spacing="sm">
        <Alert color="teal" icon={<IconCheck size={16} />} title="Database connected">
          The server is using {status.database.driver ?? 'the configured database'}. Change it with
          the <Code>DB_DRIVER</Code> environment variables.
        </Alert>
        <Group position="right">
          <Button onClick={onNext}>Continue</Button>
        </Group>
      </Stack>
    );
  }

  const database =
    driver === 'mongo'
      ? { driver, uri: mongoUri, database: mongoDb }
      : driver === 'postgres'
        ? { driver, url: postgresUrl }
        : { driver, path: sqlitePath };
  const test = () => {
    setTesting(true);
    setError(null);
    client.setup
      .testDatabase({ token, database })
      .then(setResult)
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setTesting(false));
  };

  return (
    <Stack spacing="sm">
      {status.database.issues.map((issue) => (
        <Alert key={issue.path} color="yellow" icon={<IconAlertTriangle size={16} />}>
          {issue.path}: {issue.message}
        </Alert>
      ))}
      <SegmentedControl
        value={driver}
        onChange={(value) => {
          setResult(null);
          setDriver(value === 'mongo' || value === 'postgres' ? value : 'sqlite');
        }}
        data={[
          { value: 'sqlite', label: 'SQLite' },
          { value: 'postgres', label: 'PostgreSQL' },
          { value: 'mongo', label: 'MongoDB' },
        ]}
      />
      {driver === 'sqlite' && (
        <TextInput
          label="Database file"
          description="Single node only: every role runs in one process."
          value={sqlitePath}
          onChange={(e) => setSqlitePath(e.currentTarget.value)}
        />
      )}
      {driver === 'postgres' && (
        <TextInput
          label="Connection URL"
          value={postgresUrl}
          onChange={(e) => setPostgresUrl(e.currentTarget.value)}
        />
      )}
      {driver === 'mongo' && (
        <>
          <TextInput
            label="Connection string"
            description="MongoDB must run as a replica set; change streams need it."
            value={mongoUri}
            onChange={(e) => setMongoUri(e.currentTarget.value)}
          />
          <TextInput
            label="Database name"
            value={mongoDb}
            onChange={(e) => setMongoDb(e.currentTarget.value)}
          />
        </>
      )}
      {error && <Alert color="red">{error}</Alert>}
      {result && !result.ok && (
        <Alert color="red" title="Could not connect">
          {result.error}
        </Alert>
      )}
      {result?.ok && (
        <Alert color="teal" icon={<IconCheck size={16} />} title="Connection works">
          <Stack spacing="xs">
            <Text size="sm">
              Set these environment variables on the server, restart it, then check again. The setup
              token changes on restart unless <Code>SETUP_TOKEN</Code> is set.
            </Text>
            <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {envText(result.env)}
            </Code>
            <Group spacing="xs">
              <CopyButton value={envText(result.env)}>
                {(clipboard) => (
                  <Button
                    size="xs"
                    variant="light"
                    leftIcon={<IconCopy size={14} />}
                    onClick={() => clipboard.copy()}
                  >
                    {clipboard.copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
              <Button
                size="xs"
                variant="light"
                leftIcon={<IconRefresh size={14} />}
                onClick={onRecheck}
              >
                I restarted the server
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
      <Group position="right">
        <Button onClick={test} loading={testing}>
          Test connection
        </Button>
      </Group>
    </Stack>
  );
}

function AdminStep({
  admin,
  onChange,
  onBack,
  onNext,
}: {
  admin: { username: string; password: string; confirm: string };
  onChange: (admin: { username: string; password: string; confirm: string }) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const tooShort = admin.password.length > 0 && admin.password.length < MIN_PASSWORD;
  const mismatch = admin.confirm.length > 0 && admin.confirm !== admin.password;
  const valid =
    admin.username.trim() !== '' &&
    admin.password.length >= MIN_PASSWORD &&
    admin.password === admin.confirm;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onNext();
      }}
    >
      <Stack spacing="sm">
        <Text size="sm" color="dimmed">
          This account gets the admin scope and signs in with a password. You can add more users
          later under Settings.
        </Text>
        <TextInput
          label="Username"
          autoComplete="username"
          value={admin.username}
          onChange={(e) => onChange({ ...admin, username: e.currentTarget.value })}
          required
        />
        <PasswordInput
          label="Password"
          description={`At least ${MIN_PASSWORD} characters.`}
          autoComplete="new-password"
          value={admin.password}
          onChange={(e) => onChange({ ...admin, password: e.currentTarget.value })}
          {...(tooShort ? { error: `Use at least ${MIN_PASSWORD} characters` } : {})}
          required
        />
        <PasswordInput
          label="Confirm password"
          autoComplete="new-password"
          value={admin.confirm}
          onChange={(e) => onChange({ ...admin, confirm: e.currentTarget.value })}
          {...(mismatch ? { error: 'The passwords differ' } : {})}
          required
        />
        <Group position="apart">
          <Button variant="default" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" disabled={!valid}>
            Continue
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function SetupWizard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['setup', 'status'],
    queryFn: () => client.setup.status({}),
  });
  const [token, setToken] = useState<string | null>(() => setupToken.get());
  const [step, setStep] = useState(token === null ? 0 : 1);
  const [methods, setMethods] = useState(blankMethods);
  const [admin, setAdmin] = useState({ username: 'admin', password: '', confirm: '' });
  const [finishing, setFinishing] = useState(false);
  const [failure, setFailure] = useState<{ message: string; issues: string[] } | null>(null);
  const stage = status.data?.stage;

  useEffect(() => {
    if (token === null || stage === undefined || stage === 'done') {
      return;
    }
    client.setup.verifyToken({ token }).catch(() => {
      setupToken.set(null);
      setToken(null);
      setStep(0);
    });
  }, [token, stage]);

  if (status.isLoading || !status.data) {
    return (
      <Center mih="100vh">
        {status.error ? <Alert color="red">{errorMessage(status.error)}</Alert> : <Loader />}
      </Center>
    );
  }
  if (status.data.stage === 'done' && !finishing) {
    return <Navigate to="/" replace />;
  }

  const finish = async () => {
    if (token === null) {
      return;
    }
    setFinishing(true);
    setFailure(null);
    try {
      const session = await client.setup.complete({
        token,
        admin: { username: admin.username.trim(), password: admin.password },
        methods: toAuthMethods(methods),
      });
      setupToken.set(null);
      startPasswordSession(session);
      resetAuthConfig();
      await queryClient.invalidateQueries();
      await navigate('/', { replace: true });
    } catch (error: unknown) {
      setFinishing(false);
      setFailure({
        message: errorMessage(error),
        issues: configIssues(error).map((issue) => `${issue.path}: ${issue.message}`),
      });
    }
  };
  const authReady = status.data.stage === 'auth';

  return (
    <Center mih="100vh" p="md" style={{ background: 'var(--ct-paper)' }}>
      <Stack w="100%" maw={720} miw={0} className="ct-panel" p="xl" spacing="lg">
        <Group spacing="sm">
          <BrandMark size={32} />
          <div>
            <Title order={3}>Set up Cloud Trigger</Title>
            <Text size="sm" color="dimmed">
              Choose where data lives, how people sign in, and create the first admin.
            </Text>
          </div>
        </Group>
        <Stepper active={step} breakpoint="sm" size="sm">
          <Stepper.Step label="Setup token">
            <TokenStep
              onVerified={(verified) => {
                setupToken.set(verified);
                setToken(verified);
                setStep(1);
              }}
            />
          </Stepper.Step>
          <Stepper.Step label="Database">
            {token !== null && (
              <DatabaseStep
                status={status.data}
                token={token}
                onNext={() => setStep(2)}
                onRecheck={() => void status.refetch()}
              />
            )}
          </Stepper.Step>
          <Stepper.Step label="Sign-in methods">
            <Stack spacing="sm">
              <SignInMethodsFields
                value={methods}
                onChange={setMethods}
                testOidc={(issuer) =>
                  client.setup.testOidc({ issuer, ...(token !== null && { token }) })
                }
                localLocked
              />
              <Group position="apart">
                <Button variant="default" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button onClick={() => setStep(3)}>Continue</Button>
              </Group>
            </Stack>
          </Stepper.Step>
          <Stepper.Step label="Admin account">
            <AdminStep
              admin={admin}
              onChange={setAdmin}
              onBack={() => setStep(2)}
              onNext={() => setStep(4)}
            />
          </Stepper.Step>
          <Stepper.Step label="Review">
            <Stack spacing="sm">
              <Text size="sm">
                Database: <b>{status.data.database.driver}</b>
              </Text>
              <Text size="sm">
                Sign-in: <b>password</b>
                {methods.oidcEnabled && (
                  <>
                    , <b>SSO</b> via {methods.oidc.issuer}
                  </>
                )}
                {methods.anonymousScopes.length > 0 && (
                  <>
                    , anonymous <b>{methods.anonymousScopes.join(', ')}</b>
                  </>
                )}
              </Text>
              <Text size="sm">
                Admin: <b>{admin.username}</b>
              </Text>
              {failure && (
                <Alert color="red" title="Setup failed">
                  {failure.message}
                  {failure.issues.map((issue) => (
                    <Text key={issue} size="sm">
                      {issue}
                    </Text>
                  ))}
                </Alert>
              )}
              <Group position="apart">
                <Button variant="default" onClick={() => setStep(3)}>
                  Back
                </Button>
                <Button onClick={() => void finish()} loading={finishing} disabled={!authReady}>
                  Finish setup
                </Button>
              </Group>
            </Stack>
          </Stepper.Step>
        </Stepper>
      </Stack>
    </Center>
  );
}
