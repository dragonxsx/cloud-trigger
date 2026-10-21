import type { Scope } from '@cloud-trigger/api-contract';
import {
  Alert,
  Button,
  Collapse,
  Group,
  NumberInput,
  Radio,
  SimpleGrid,
  Stack,
  Switch,
  TextInput,
} from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconPlugConnected } from '@tabler/icons-react';
import { useState } from 'react';
import { z } from 'zod';

import {
  LEVEL_DESCRIPTIONS,
  LEVEL_LABELS,
  accessLevel,
  levelColor,
  levelDescription,
  topScope,
} from '../lib/access';
import type { AuthMethodsInput, AuthSettingsDto } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { HintBadge } from '../lib/status';

export const SCOPES: readonly Scope[] = ['read', 'write', 'admin'];

export const isScope = (value: string): value is Scope =>
  value === 'read' || value === 'write' || value === 'admin';

export interface SignInMethodsValue {
  readonly localEnabled: boolean;
  readonly sessionTtlHours: number;
  readonly oidcEnabled: boolean;
  readonly oidc: {
    readonly issuer: string;
    readonly clientId: string;
    readonly audience: string;
    readonly jwksUri: string;
    readonly scopePrefix: string;
    readonly uiScope: string;
    readonly defaultScopes: readonly Scope[];
  };
  readonly anonymousScopes: readonly Scope[];
}

export const blankMethods: SignInMethodsValue = {
  localEnabled: true,
  sessionTtlHours: 12,
  oidcEnabled: false,
  oidc: {
    issuer: '',
    clientId: '',
    audience: '',
    jwksUri: '',
    scopePrefix: 'cloud-trigger:',
    uiScope: 'openid profile cloud-trigger:read cloud-trigger:write',
    defaultScopes: ['read'],
  },
  anonymousScopes: [],
};

const trimmed = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value.trim();

export const toAuthMethods = (value: SignInMethodsValue): AuthMethodsInput => ({
  local: { enabled: value.localEnabled, sessionTtlMinutes: Math.round(value.sessionTtlHours * 60) },
  oidc: {
    enabled: value.oidcEnabled,
    ...(trimmed(value.oidc.issuer) !== undefined && { issuer: value.oidc.issuer.trim() }),
    ...(trimmed(value.oidc.clientId) !== undefined && { clientId: value.oidc.clientId.trim() }),
    ...(trimmed(value.oidc.audience) !== undefined && { audience: value.oidc.audience.trim() }),
    ...(trimmed(value.oidc.jwksUri) !== undefined && { jwksUri: value.oidc.jwksUri.trim() }),
    scopePrefix: value.oidc.scopePrefix,
    uiScope: value.oidc.uiScope,
    defaultScopes: [...value.oidc.defaultScopes],
  },
  anonymous: { scopes: [...value.anonymousScopes] },
});

export const fromAuthSettings = (settings: AuthSettingsDto): SignInMethodsValue => ({
  localEnabled: settings.local.enabled,
  sessionTtlHours: settings.local.sessionTtlMinutes / 60,
  oidcEnabled: settings.oidc.enabled,
  oidc: {
    issuer: settings.oidc.issuer ?? '',
    clientId: settings.oidc.clientId ?? '',
    audience: settings.oidc.audience ?? '',
    jwksUri: settings.oidc.jwksUri ?? '',
    scopePrefix: settings.oidc.scopePrefix,
    uiScope: settings.oidc.uiScope,
    defaultScopes: settings.oidc.defaultScopes,
  },
  anonymousScopes: settings.anonymous.scopes,
});

type OidcTest = { ok: boolean; error: string | null; jwksUri: string | null };

export type MethodErrors = Readonly<Record<string, string>>;

const NONE = 'none';

export function ScopeLevel({
  label,
  description,
  value,
  onChange,
  noneLabel,
  noneDescription,
  error,
}: {
  label: string;
  description?: string | undefined;
  value: readonly Scope[];
  onChange: (scopes: Scope[]) => void;
  noneLabel?: string | undefined;
  noneDescription?: string | undefined;
  error?: string | undefined;
}) {
  return (
    <Radio.Group
      label={label}
      {...(description === undefined ? {} : { description })}
      {...(error === undefined ? {} : { error })}
      orientation="vertical"
      spacing="xs"
      value={topScope(value) ?? NONE}
      onChange={(next) => onChange(isScope(next) ? [next] : [])}
    >
      {noneLabel !== undefined && (
        <Radio
          value={NONE}
          label={noneLabel}
          {...(noneDescription === undefined ? {} : { description: noneDescription })}
        />
      )}
      {SCOPES.map((scope) => (
        <Radio
          key={scope}
          value={scope}
          label={LEVEL_LABELS[scope]}
          description={LEVEL_DESCRIPTIONS[scope]}
        />
      ))}
    </Radio.Group>
  );
}

export function ScopeBadge({ scopes }: { scopes: readonly Scope[] }) {
  return (
    <HintBadge
      label={accessLevel(scopes)}
      hint={levelDescription(scopes)}
      color={levelColor(scopes)}
    />
  );
}

const ISSUER_URL = z.url();

export function methodsErrors(value: SignInMethodsValue): MethodErrors {
  const errors: Record<string, string> = {};
  if (value.oidcEnabled) {
    const issuer = value.oidc.issuer.trim();
    if (issuer === '') {
      errors['oidc.issuer'] = 'Enter the issuer URL, or turn single sign-on off';
    } else if (!ISSUER_URL.safeParse(issuer).success) {
      errors['oidc.issuer'] = 'Enter a full URL, e.g. https://id.example.com/realms/main';
    }
    const jwks = value.oidc.jwksUri.trim();
    if (jwks !== '' && !ISSUER_URL.safeParse(jwks).success) {
      errors['oidc.jwksUri'] = 'Enter a full URL, or leave it empty';
    }
  }
  if (!Number.isFinite(value.sessionTtlHours) || value.sessionTtlHours < 1) {
    errors['local.sessionTtlMinutes'] = 'Use at least 1 hour';
  }

  return errors;
}

export const METHOD_FIELDS: readonly string[] = [
  'local.sessionTtlMinutes',
  'oidc.issuer',
  'oidc.clientId',
  'oidc.audience',
  'oidc.scopePrefix',
  'oidc.uiScope',
  'oidc.jwksUri',
  'oidc.defaultScopes',
  'anonymous.scopes',
];

export const methodField = (path: string): string | undefined => {
  const bare = path.replace(/^methods\./, '');

  return METHOD_FIELDS.find((field) => bare === field || bare.startsWith(`${field}.`));
};

const fieldError = (errors: MethodErrors, path: string) => {
  const message = errors[path];

  return message === undefined ? {} : { error: message };
};

export function SignInMethodsFields({
  value,
  onChange,
  testOidc,
  localLocked = false,
  errors = {},
}: {
  value: SignInMethodsValue;
  onChange: (value: SignInMethodsValue) => void;
  testOidc: (issuer: string) => Promise<OidcTest>;
  localLocked?: boolean;
  errors?: MethodErrors;
}) {
  const [test, setTest] = useState<OidcTest | null>(null);
  const [testing, setTesting] = useState(false);
  const oidc = (patch: Partial<SignInMethodsValue['oidc']>) =>
    onChange({ ...value, oidc: { ...value.oidc, ...patch } });
  const anonymous = topScope(value.anonymousScopes);

  return (
    <Stack spacing="lg">
      <Stack spacing="xs">
        <Switch
          label="Username and password"
          description={
            localLocked
              ? 'Always on during setup, so the admin account can sign in.'
              : 'Accounts managed under Settings → Users.'
          }
          checked={value.localEnabled || localLocked}
          disabled={localLocked}
          onChange={(e) => onChange({ ...value, localEnabled: e.currentTarget.checked })}
        />
        <NumberInput
          label="Session length (hours)"
          min={1}
          max={720}
          w={200}
          value={value.sessionTtlHours}
          onChange={(hours) => onChange({ ...value, sessionTtlHours: hours ?? 12 })}
          {...fieldError(errors, 'local.sessionTtlMinutes')}
        />
      </Stack>

      <Stack spacing="xs">
        <Switch
          label="Single sign-on (OpenID Connect)"
          description="Accept tokens from an identity provider such as Keycloak, Entra ID or Okta."
          checked={value.oidcEnabled}
          onChange={(e) => onChange({ ...value, oidcEnabled: e.currentTarget.checked })}
        />
        <Collapse in={value.oidcEnabled}>
          <Stack spacing="sm" pl="xl" pt="xs">
            <Group align="flex-start" spacing="xs" noWrap>
              <TextInput
                label="Issuer URL"
                placeholder="https://id.example.com/realms/main"
                style={{ flex: 1 }}
                value={value.oidc.issuer}
                onChange={(e) => {
                  setTest(null);
                  oidc({ issuer: e.currentTarget.value });
                }}
                {...fieldError(errors, 'oidc.issuer')}
                withAsterisk
              />
              <Button
                variant="default"
                mt={22}
                leftIcon={<IconPlugConnected size={16} />}
                loading={testing}
                disabled={value.oidc.issuer.trim() === ''}
                onClick={() => {
                  setTesting(true);
                  testOidc(value.oidc.issuer.trim())
                    .then(setTest)
                    .catch((error: unknown) =>
                      setTest({ ok: false, error: errorMessage(error), jwksUri: null }),
                    )
                    .finally(() => setTesting(false));
                }}
              >
                Test discovery
              </Button>
            </Group>
            {test?.ok && (
              <Alert color="teal" icon={<IconCheck size={16} />}>
                Found the signing keys at {test.jwksUri}
              </Alert>
            )}
            {test && !test.ok && (
              <Alert color="red" icon={<IconAlertTriangle size={16} />}>
                {test.error}
              </Alert>
            )}
            <SimpleGrid cols={2} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
              <TextInput
                label="UI client id"
                description="Public client with PKCE. Leave empty for API-only tokens."
                value={value.oidc.clientId}
                onChange={(e) => oidc({ clientId: e.currentTarget.value })}
                {...fieldError(errors, 'oidc.clientId')}
              />
              <TextInput
                label="Audience"
                description="Required aud claim, if any."
                value={value.oidc.audience}
                onChange={(e) => oidc({ audience: e.currentTarget.value })}
                {...fieldError(errors, 'oidc.audience')}
              />
              <TextInput
                label="Scope prefix"
                description="Token scopes like cloud-trigger:write map to write."
                value={value.oidc.scopePrefix}
                onChange={(e) => oidc({ scopePrefix: e.currentTarget.value })}
                {...fieldError(errors, 'oidc.scopePrefix')}
              />
              <TextInput
                label="Scopes the UI requests"
                value={value.oidc.uiScope}
                onChange={(e) => oidc({ uiScope: e.currentTarget.value })}
                {...fieldError(errors, 'oidc.uiScope')}
              />
              <TextInput
                label="JWKS URL override"
                description="Optional; discovery finds it otherwise."
                value={value.oidc.jwksUri}
                onChange={(e) => oidc({ jwksUri: e.currentTarget.value })}
                {...fieldError(errors, 'oidc.jwksUri')}
              />
            </SimpleGrid>
            <ScopeLevel
              label="Default access"
              description="For valid tokens that carry no Cloud Trigger scope."
              value={value.oidc.defaultScopes}
              onChange={(defaultScopes) => oidc({ defaultScopes })}
              noneLabel="No access"
              noneDescription="Tokens without a Cloud Trigger scope are refused."
              error={errors['oidc.defaultScopes']}
            />
          </Stack>
        </Collapse>
      </Stack>

      <Stack spacing="xs">
        <ScopeLevel
          label="Anonymous access"
          description="What visitors who are not signed in can do."
          value={value.anonymousScopes}
          onChange={(anonymousScopes) => onChange({ ...value, anonymousScopes })}
          noneLabel="None"
          noneDescription="Everyone must sign in."
          error={errors['anonymous.scopes']}
        />
        {anonymous === 'admin' && (
          <Alert
            color="red"
            icon={<IconAlertTriangle size={16} />}
            title="Anyone gets full control"
            mt="xs"
          >
            Anyone who can reach this server can manage users, API keys and sign-in methods, and
            change or delete every job. Only use this on an isolated machine.
          </Alert>
        )}
        {anonymous === 'write' && (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />} mt="xs">
            Anyone who can reach this server will be able to change jobs. Use this only on a trusted
            network.
          </Alert>
        )}
      </Stack>
    </Stack>
  );
}
