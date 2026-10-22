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
import { type UseFormReturnType, useForm } from '@mantine/form';
import { useGo, useInvalidateAuthStore } from '@refinedev/core';
import { IconAlertTriangle, IconCheck, IconCopy, IconRefresh } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';

import { AuthShell, BrandMark, useFocusOnMount } from '../../components/Brand';
import { NewPasswordFields, confirmError, passwordError } from '../../components/NewPasswordFields';
import {
  SignInMethodsFields,
  type SignInMethodsValue,
  blankMethods,
  methodsErrors,
  toAuthMethods,
} from '../../components/SignInMethods';
import { type SetupStatusDto, client, orpc } from '../../lib/api';
import { configIssues, errorMessage, focusFirstInvalidField } from '../../lib/errors';
import { resetAuthConfig } from '../../lib/oidc';
import { setupToken } from '../../lib/session';
import { startPasswordSession } from '../../providers/auth-provider';

type Driver = 'sqlite' | 'postgres' | 'mongo';
type DatabaseTest = Awaited<ReturnType<typeof client.setup.testDatabase>>;
type DatabaseOutcome = { key: string; result: DatabaseTest } | { key: string; error: string };

interface DatabaseValues {
  driver: Driver;
  sqlitePath: string;
  postgresUrl: string;
  mongoUri: string;
  mongoDb: string;
}

const toDatabase = ({ driver, sqlitePath, postgresUrl, mongoUri, mongoDb }: DatabaseValues) =>
  driver === 'mongo'
    ? { driver, uri: mongoUri, database: mongoDb }
    : driver === 'postgres'
      ? { driver, url: postgresUrl }
      : { driver, path: sqlitePath };

function TokenStep({
  expired,
  onVerified,
}: {
  expired: boolean;
  onVerified: (token: string) => void;
}) {
  const focusRef = useFocusOnMount<HTMLInputElement>();
  const form = useForm({
    initialValues: { token: '' },
    validate: {
      token: (value) => (value.trim() === '' ? 'Paste the setup token from the server log' : null),
    },
  });
  const [checking, setChecking] = useState(false);

  return (
    <form
      noValidate
      onSubmit={form.onSubmit(({ token }) => {
        setChecking(true);
        client.setup
          .verifyToken({ token: token.trim() })
          .then(() => onVerified(token.trim()))
          .catch((failure: unknown) => form.setFieldError('token', errorMessage(failure)))
          .finally(() => setChecking(false));
      })}
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
          {...form.getInputProps('token')}
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
  const form = useForm<DatabaseValues>({
    initialValues: {
      driver: status.database.driver ?? 'sqlite',
      sqlitePath: './data/cloud-trigger.db',
      postgresUrl: '',
      mongoUri: 'mongodb://localhost:27017/?replicaSet=rs0',
      mongoDb: 'cloud_trigger',
    },
    validate: {
      postgresUrl: (value, values) =>
        values.driver === 'postgres' && value.trim() === '' ? 'Enter the connection URL' : null,
    },
  });
  const [outcome, setOutcome] = useState<DatabaseOutcome | null>(null);
  const [testing, setTesting] = useState(false);
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

  const { driver } = form.values;
  const database = toDatabase(form.values);
  const key = JSON.stringify(database);
  // An outcome only describes the settings it was tested with; editing a field hides it.
  const current = outcome?.key === key ? outcome : null;
  const result = current !== null && 'result' in current ? current.result : null;
  const error = current !== null && 'error' in current ? current.error : null;
  const test = () => {
    if (form.validate().hasErrors) {
      focusFirstInvalidField();

      return;
    }
    setTesting(true);
    setOutcome(null);
    setStillMissing(false);
    client.setup
      .testDatabase({ token, database })
      .then((tested) => setOutcome({ key, result: tested }))
      .catch((failure: unknown) => setOutcome({ key, error: errorMessage(failure) }))
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
          form.setFieldValue('driver', value === 'mongo' || value === 'postgres' ? value : 'sqlite')
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
          {...form.getInputProps('sqlitePath')}
        />
      )}
      {driver === 'postgres' && (
        <TextInput
          label="Connection URL"
          description="Include the user, password, host, port and database name."
          placeholder="postgres://user:password@localhost:5432/cloud_trigger"
          autoComplete="off"
          {...form.getInputProps('postgresUrl')}
          withAsterisk
        />
      )}
      {driver === 'mongo' && (
        <>
          <TextInput
            label="Connection string"
            description="MongoDB must run as a replica set; change streams need it."
            autoComplete="off"
            {...form.getInputProps('mongoUri')}
          />
          <TextInput label="Database name" {...form.getInputProps('mongoDb')} />
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
      {works && stillMissing && (
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

interface AdminValues {
  username: string;
  password: string;
  confirm: string;
}

function AdminStep({
  form,
  onBack,
  onNext,
}: {
  form: UseFormReturnType<AdminValues>;
  onBack: () => void;
  onNext: () => void;
}) {
  const [submitted, setSubmitted] = useState(false);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        setSubmitted(true);
        form.onSubmit(onNext, () => focusFirstInvalidField())(e);
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
          {...form.getInputProps('username')}
          withAsterisk
        />
        <NewPasswordFields
          label="Password"
          password={form.values.password}
          onPasswordChange={(password) => form.setFieldValue('password', password)}
          confirm={form.values.confirm}
          onConfirmChange={(confirm) => form.setFieldValue('confirm', confirm)}
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
  const go = useGo();
  const queryClient = useQueryClient();
  const invalidateAuthStore = useInvalidateAuthStore();
  const status = useQuery(orpc.setup.status.queryOptions({ input: {} }));
  const [token, setToken] = useState<string | null>(() => setupToken.get());
  const [step, setStep] = useState(token === null ? 0 : 1);
  const methodsForm = useForm<SignInMethodsValue>({
    initialValues: blankMethods,
    validate: methodsErrors,
  });
  const adminForm = useForm<AdminValues>({
    initialValues: { username: 'admin', password: '', confirm: '' },
    validate: {
      username: (value) => (value.trim() === '' ? 'Enter a username' : null),
      password: (value) => passwordError(value, true) ?? null,
      confirm: (value, values) => confirmError(values.password, value, true) ?? null,
    },
  });
  const [finishing, setFinishing] = useState(false);
  const [failure, setFailure] = useState<{ message: string; issues: string[] } | null>(null);
  const [tokenExpired, setTokenExpired] = useState(false);
  const [methodsSubmitted, setMethodsSubmitted] = useState(false);
  const stage = status.data?.stage;
  const methods = methodsForm.values;
  const admin = adminForm.values;

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
      await Promise.all([
        invalidateAuthStore(),
        queryClient.invalidateQueries({ queryKey: orpc.setup.status.key() }),
      ]);
      go({ to: '/', type: 'replace' });
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
              onChange={methodsForm.setValues}
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
                  if (methodsForm.validate().hasErrors) {
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
          <AdminStep form={adminForm} onBack={() => setStep(2)} onNext={() => setStep(4)} />
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
