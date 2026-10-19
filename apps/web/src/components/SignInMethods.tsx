import type { Scope } from '@cloud-trigger/api-contract';
import {
  Alert,
  Button,
  Chip,
  Collapse,
  Group,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconPlugConnected } from '@tabler/icons-react';
import { useState } from 'react';

import type { AuthMethodsInput, AuthSettingsDto } from '../lib/api';
import { errorMessage } from '../lib/errors';

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

export function ScopeChips({
  value,
  onChange,
}: {
  value: readonly Scope[];
  onChange: (scopes: Scope[]) => void;
}) {
  return (
    <Chip.Group
      multiple
      value={[...value]}
      onChange={(next) => onChange(next.filter(isScope))}
      spacing="xs"
    >
      {SCOPES.map((scope) => (
        <Chip key={scope} value={scope} size="sm">
          {scope}
        </Chip>
      ))}
    </Chip.Group>
  );
}

export function SignInMethodsFields({
  value,
  onChange,
  testOidc,
  localLocked = false,
}: {
  value: SignInMethodsValue;
  onChange: (value: SignInMethodsValue) => void;
  testOidc: (issuer: string) => Promise<OidcTest>;
  localLocked?: boolean;
}) {
  const [test, setTest] = useState<OidcTest | null>(null);
  const [testing, setTesting] = useState(false);
  const oidc = (patch: Partial<SignInMethodsValue['oidc']>) =>
    onChange({ ...value, oidc: { ...value.oidc, ...patch } });

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
            <Group align="flex-end" spacing="xs" noWrap>
              <TextInput
                label="Issuer URL"
                placeholder="https://id.example.com/realms/main"
                style={{ flex: 1 }}
                value={value.oidc.issuer}
                onChange={(e) => {
                  setTest(null);
                  oidc({ issuer: e.currentTarget.value });
                }}
                required
              />
              <Button
                variant="default"
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
              />
              <TextInput
                label="Audience"
                description="Required aud claim, if any."
                value={value.oidc.audience}
                onChange={(e) => oidc({ audience: e.currentTarget.value })}
              />
              <TextInput
                label="Scope prefix"
                description="Token scopes like cloud-trigger:write map to write."
                value={value.oidc.scopePrefix}
                onChange={(e) => oidc({ scopePrefix: e.currentTarget.value })}
              />
              <TextInput
                label="Scopes the UI requests"
                value={value.oidc.uiScope}
                onChange={(e) => oidc({ uiScope: e.currentTarget.value })}
              />
              <TextInput
                label="JWKS URL override"
                description="Optional; discovery finds it otherwise."
                value={value.oidc.jwksUri}
                onChange={(e) => oidc({ jwksUri: e.currentTarget.value })}
              />
              <Stack spacing={4}>
                <Text size="sm" weight={500}>
                  Default scopes
                </Text>
                <Text size="xs" color="dimmed">
                  For valid tokens that carry no Cloud Trigger scope.
                </Text>
                <ScopeChips
                  value={value.oidc.defaultScopes}
                  onChange={(defaultScopes) => oidc({ defaultScopes })}
                />
              </Stack>
            </SimpleGrid>
          </Stack>
        </Collapse>
      </Stack>

      <Stack spacing={4}>
        <Text size="sm" weight={500}>
          Anonymous access
        </Text>
        <Text size="xs" color="dimmed">
          Scopes for visitors who are not signed in. Select none to require sign-in.
        </Text>
        <ScopeChips
          value={value.anonymousScopes}
          onChange={(anonymousScopes) => onChange({ ...value, anonymousScopes })}
        />
        {value.anonymousScopes.some((scope) => scope !== 'read') && (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />} mt="xs">
            Anyone who can reach this server will be able to change jobs. Use this only on a trusted
            network.
          </Alert>
        )}
      </Stack>
    </Stack>
  );
}
