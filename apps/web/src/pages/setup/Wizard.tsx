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

import { AuthShell, BrandMark, useFocusOnMount } from '../../components/Brand';
import { NewPasswordFields, passwordValid } from '../../components/NewPasswordFields';
import {
  SignInMethodsFields,
  blankMethods,
  methodsErrors,
  toAuthMethods,
} from '../../components/SignInMethods';
import { type SetupStatusDto, client } from '../../lib/api';
import { configIssues, errorMessage, focusFirstInvalidField } from '../../lib/errors';
import { resetAuthConfig } from '../../lib/oidc';
import { setupToken } from '../../lib/session';
import { startPasswordSession } from '../../providers/auth-provider';

type Driver = 'sqlite' | 'postgres' | 'mongo';
type DatabaseTest = Awaited<ReturnType<typeof client.setup.testDatabase>>;

function TokenStep({
  expired,
  onVerified,
}: {
  expired: boolean;
  onVerified: (token: string) => void;
}) {
  const focusRef = useFocusOnMount<HTMLInputElement>();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim() === '') {
          setError('Paste the setup token from the server log');

          return;
        }
        setChecking(true);
        client.setup
          .verifyToken({ token: token.trim() })
          .then(() => onVerified(token.trim()))
          .catch((failure: unknown) => setError(errorMessage(failure)))
          .finally(() => setChecking(false));
      }}
    >
      <Stack spacing="sm">
        {expired && (
          <Alert
            color="yellow"
            icon={<IconAlertTriangle size={16} />}
            title="New setup token needed"
          >
            The server restarted and issued a new setup token. Copy it from the server log (look for
            “Setup required”) and paste it below.
          </Alert>
        )}
        <Text size="sm" color="dimmed">
          The server printed a one-time setup token in its log when it started (look for “Setup
          required”). If you set <Code>SETUP_TOKEN</Code>, use that value.
        </Text>
        <PasswordInput
          label="Setup token"
          autoComplete="off"
          ref={focusRef}
          toggleTabIndex={0}
          value={token}
          onChange={(e) => {
            setError(null);
            setToken(e.currentTarget.value);
          }}
          {...(error ? { error } : {})}
          withAsterisk
        />
        <Group position="right">
          <Button type="submit" loading={checking}>
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

const POSTGRES_HINT =
  'Check the host, port, user name and password, and that the database exists and accepts connections from the server.';
const MONGO_HINT =
  'Check the host and port, that MongoDB runs as a replica set, and that the user can reach the database.';
const SQLITE_HINT = 'Check that the folder exists and the server process can write to it.';

const failureHint = (driver: Driver): string =>
  driver === 'postgres' ? POSTGRES_HINT : driver === 'mongo' ? MONGO_HINT : SQLITE_HINT;

function DatabaseStep({
  status,
  token,
  onNext,
  onRecheck,
}: {
  status: SetupStatusDto;
  token: string;
  onNext: () => void;
  onRecheck: () => Promise<boolean>;
}) {
  const [driver, setDriver] = useState<Driver>(status.database.driver ?? 'sqlite');
  const [mongoUri, setMongoUri] = useState('mongodb://localhost:27017/?replicaSet=rs0');
  const [mongoDb, setMongoDb] = useState('cloud_trigger');
  const [postgresUrl, setPostgresUrl] = useState('');
  const [sqlitePath, setSqlitePath] = useState('./data/cloud-trigger.db');
  const [result, setResult] = useState<DatabaseTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [stillMissing, setStillMissing] = useState(false);

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

  const edit = (apply: () => void) => {
    setResult(null);
    setError(null);
    setStillMissing(false);
    apply();
  };
  const database =
    driver === 'mongo'
      ? { driver, uri: mongoUri, database: mongoDb }
      : driver === 'postgres'
        ? { driver, url: postgresUrl }
        : { driver, path: sqlitePath };
  const test = () => {
    if (driver === 'postgres' && postgresUrl.trim() === '') {
      setError('Enter the connection URL');

      return;
    }
    setTesting(true);
    setError(null);
    setStillMissing(false);
    client.setup
      .testDatabase({ token, database })
      .then(setResult)
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setTesting(false));
  };
  const recheck = () => {
    setRechecking(true);
    setStillMissing(false);
    onRecheck()
      .then((connected) => setStillMissing(!connected))
      .catch(() => setStillMissing(true))
      .finally(() => setRechecking(false));
  };
  const works = result?.ok === true;

  return (
    <Stack spacing="sm">
      <Text size="sm" color="dimmed">
        Cloud Trigger needs a database. Pick one and test the connection. You then set a few
        environment variables on the server and restart it.
      </Text>
      {!works && status.database.issues.length > 0 && (
        <Alert color="gray" title="Current server settings">
          <Stack spacing={2}>
            {status.database.issues.map((issue) => (
              <Text key={issue.path} size="sm">
                <Code>{issue.path}</Code> {issue.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      <SegmentedControl
        aria-label="Database"
        value={driver}
        onChange={(value) =>
          edit(() => setDriver(value === 'mongo' || value === 'postgres' ? value : 'sqlite'))
        }
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
          onChange={(e) => {
            const next = e.currentTarget.value;
            edit(() => setSqlitePath(next));
          }}
        />
      )}
      {driver === 'postgres' && (
        <TextInput
          label="Connection URL"
          description="Include the user, password, host, port and database name."
          placeholder="postgres://user:password@localhost:5432/cloud_trigger"
          autoComplete="off"
          value={postgresUrl}
          onChange={(e) => {
            const next = e.currentTarget.value;
            edit(() => setPostgresUrl(next));
          }}
          withAsterisk
        />
      )}
      {driver === 'mongo' && (
        <>
          <TextInput
            label="Connection string"
            description="MongoDB must run as a replica set; change streams need it."
            autoComplete="off"
            value={mongoUri}
            onChange={(e) => {
              const next = e.currentTarget.value;
              edit(() => setMongoUri(next));
            }}
          />
          <TextInput
            label="Database name"
            value={mongoDb}
            onChange={(e) => {
              const next = e.currentTarget.value;
              edit(() => setMongoDb(next));
            }}
          />
        </>
      )}
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      {result && !result.ok && (
        <Alert color="red" title="Could not connect" role="alert">
          <Stack spacing={4}>
            <Text size="sm">{result.error}</Text>
            <Text size="sm">{failureHint(driver)}</Text>
          </Stack>
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
            </Group>
          </Stack>
        </Alert>
      )}
      {stillMissing && (
        <Alert
          color="yellow"
          icon={<IconAlertTriangle size={16} />}
          title="Still no database"
          role="alert"
        >
          The server still runs without a database. Check that the environment variables are set
          where the server reads them, restart it, and wait until it has started before checking
          again.
        </Alert>
      )}
      <Group position="right" spacing="xs">
        <Button onClick={test} loading={testing} variant={works ? 'default' : 'filled'}>
          Test connection
        </Button>
        {works && (
          <Button leftIcon={<IconRefresh size={16} />} loading={rechecking} onClick={recheck}>
            I restarted the server, check again
          </Button>
        )}
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
  const [submitted, setSubmitted] = useState(false);
  const usernameError = submitted && admin.username.trim() === '' ? 'Enter a username' : undefined;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (admin.username.trim() === '' || !passwordValid(admin.password, admin.confirm)) {
          focusFirstInvalidField(e.currentTarget);

          return;
        }
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
          {...(usernameError === undefined ? {} : { error: usernameError })}
          withAsterisk
        />
        <NewPasswordFields
          label="Password"
          password={admin.password}
          onPasswordChange={(password) => onChange({ ...admin, password })}
          confirm={admin.confirm}
          onConfirmChange={(confirm) => onChange({ ...admin, confirm })}
          submitted={submitted}
        />
        <Group position="apart">
          <Button variant="default" onClick={onBack}>
            Back
          </Button>
          <Button type="submit">Continue</Button>
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
  const [tokenExpired, setTokenExpired] = useState(false);
  const [methodsSubmitted, setMethodsSubmitted] = useState(false);
  const stage = status.data?.stage;

  useEffect(() => {
    if (token === null || stage === undefined || stage === 'done') {
      return;
    }
    client.setup.verifyToken({ token }).catch(() => {
      setupToken.set(null);
      setToken(null);
      setTokenExpired(true);
      setStep(0);
    });
  }, [token, stage]);

  if (status.isLoading || !status.data) {
    return (
      <Center component="main" mih="100vh" p="md">
        {status.error ? (
          <Alert color="red" title="Couldn't reach the server" role="alert" maw={420}>
            <Stack spacing="sm">
              <Text size="sm">{errorMessage(status.error)}</Text>
              <Group>
                <Button size="xs" color="red" onClick={() => void status.refetch()}>
                  Try again
                </Button>
              </Group>
            </Stack>
          </Alert>
        ) : (
          <Loader aria-label="Loading setup" />
        )}
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
  const methodProblems = methodsSubmitted ? methodsErrors(methods) : {};

  return (
    <AuthShell width={720}>
      <Group spacing="sm" noWrap>
        <BrandMark size={32} />
        <div>
          <Title order={1} size="h3">
            Set up Cloud Trigger
          </Title>
          <Text size="sm" color="dimmed">
            Choose where data lives, how people sign in, and create the first admin.
          </Text>
        </div>
      </Group>
      <Stepper active={step} breakpoint="sm" size="sm">
        <Stepper.Step label="Setup token">
          <TokenStep
            expired={tokenExpired}
            onVerified={(verified) => {
              setupToken.set(verified);
              setToken(verified);
              setTokenExpired(false);
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
              onRecheck={async () => (await status.refetch()).data?.stage !== 'database'}
            />
          )}
        </Stepper.Step>
        <Stepper.Step label="Sign-in methods">
          <Stack spacing="sm">
            <SignInMethodsFields
              value={methods}
              onChange={setMethods}
              errors={methodProblems}
              testOidc={(issuer) =>
                client.setup.testOidc({ issuer, ...(token !== null && { token }) })
              }
              localLocked
            />
            <Group position="apart">
              <Button variant="default" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button
                onClick={() => {
                  setMethodsSubmitted(true);
                  if (Object.keys(methodsErrors(methods)).length > 0) {
                    focusFirstInvalidField();

                    return;
                  }
                  setStep(3);
                }}
              >
                Continue
              </Button>
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
              <Alert color="red" title="Setup failed" role="alert">
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
    </AuthShell>
  );
}
