import {
  type ClassifiedOperation,
  type Endpoint,
  ImportMode,
  type ImportStatus,
  type ImportedOperation,
  OpenApiImportOptions,
  classifyOperations,
  endpointProvider,
  isRecord,
  planEndpointImport,
} from '@cloud-trigger/core';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Chip,
  Code,
  FileButton,
  Group,
  List,
  Modal,
  SegmentedControl,
  Select,
  SimpleGrid,
  Spoiler,
  Stack,
  Stepper,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconAlertTriangle, IconFileImport, IconSearch } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { z } from 'zod';

import { type ApiClient, client } from '../lib/api';
import { configIssues, errorMessage } from '../lib/errors';
import { countOf } from '../lib/format';

type AnalysisDto = Awaited<ReturnType<ApiClient['connections']['openapiPreview']>>;
type AuthSuggestion = NonNullable<AnalysisDto['auth']>;
const SourceKind = z.enum(['upload', 'paste', 'url']);
type SourceKind = z.output<typeof SourceKind>;
const Naming = OpenApiImportOptions.shape.naming.unwrap();
type Naming = z.output<typeof Naming>;

export const MAX_ENDPOINTS = 200;
const KEEP_BASE_URL = '';
const MONO = { fontFamily: '"JetBrains Mono Variable", monospace', fontSize: 13 };

const METHOD_COLOR: Record<string, string> = {
  GET: 'cyan',
  POST: 'violet',
  PUT: 'indigo',
  PATCH: 'grape',
  DELETE: 'pink',
};
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const STATUS_BADGE: Record<ImportStatus, { label: string; color: string }> = {
  new: { label: 'New', color: 'cyan' },
  changed: { label: 'Changed', color: 'grape' },
  unchanged: { label: 'Unchanged', color: 'dark' },
};

const MODE_LABELS: { value: ImportMode; label: string }[] = [
  { value: 'update', label: 'Update' },
  { value: 'keep_both', label: 'Keep both' },
  { value: 'skip', label: 'Skip' },
];

const isSourceKind = (v: string): v is SourceKind => SourceKind.safeParse(v).success;
const isNaming = (v: string): v is Naming => Naming.safeParse(v).success;
const isMode = (v: string | null): v is ImportMode => ImportMode.safeParse(v).success;

const finalPath = (operation: ImportedOperation): string => {
  const { config } = endpointProvider(operation.endpoint).ref;
  const url = isRecord(config) ? config['url'] : undefined;

  return typeof url === 'string' && url !== '' ? url : operation.path;
};

const pathOf = (url: string): string | undefined => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
};

export const suggestedPrefix = (server: string | undefined, baseUrl: string | undefined) => {
  const serverPath = server === undefined ? undefined : pathOf(server);
  const basePath = baseUrl === undefined ? '' : (pathOf(baseUrl) ?? '');

  return serverPath !== undefined && serverPath.startsWith(basePath)
    ? serverPath.slice(basePath.length)
    : '';
};

export interface OpenApiImportResult {
  readonly endpoints: readonly Endpoint[];
  readonly baseUrl?: string | undefined;
  readonly auth?: AuthSuggestion | undefined;
  readonly title: string;
  readonly added: number;
  readonly updated: number;
}

interface Props {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly endpoints: readonly Endpoint[];
  readonly baseUrl: string | undefined;
  readonly onApply: (result: OpenApiImportResult) => void;
}

function MethodBadge({ method }: { method: string }) {
  return (
    <Badge variant="outline" color={METHOD_COLOR[method] ?? 'gray'} radius="sm" w={72}>
      {method}
    </Badge>
  );
}

function Names({ label, names }: { label: string; names: readonly string[] }) {
  return names.length > 0 ? (
    <Text size="sm">
      <b>
        {label} ({names.length}):
      </b>{' '}
      {names.join(', ')}
    </Text>
  ) : null;
}

function Warnings({ warnings }: { warnings: AnalysisDto['warnings'] }) {
  return warnings.length === 0 ? null : (
    <Alert
      color="yellow"
      icon={<IconAlertTriangle size={18} />}
      title={countOf(warnings.length, 'warning')}
    >
      <Spoiler maxHeight={60} showLabel="Show all" hideLabel="Hide">
        <List size="sm" spacing={2}>
          {warnings.map((w) => (
            <List.Item key={`${w.path}-${w.message}`}>
              <Text span className="ct-mono" size="xs">
                {w.path}
              </Text>{' '}
              {w.message}
            </List.Item>
          ))}
        </List>
      </Spoiler>
    </Alert>
  );
}

function SourceStep(p: {
  kind: SourceKind;
  text: string;
  url: string;
  fileName: string;
  onKind: (kind: SourceKind) => void;
  onText: (text: string, fileName?: string) => void;
  onUrl: (url: string) => void;
}) {
  return (
    <Stack spacing="sm">
      <Text size="sm" color="dimmed">
        OpenAPI 2.0 (Swagger) to 3.2, as JSON or YAML. Each operation becomes an endpoint you can
        pick in jobs. Nothing is saved until you save the connection.
      </Text>
      <SegmentedControl
        value={p.kind}
        onChange={(v) => isSourceKind(v) && p.onKind(v)}
        data={[
          { value: 'upload', label: 'Upload file' },
          { value: 'paste', label: 'Paste' },
          { value: 'url', label: 'From URL' },
        ]}
      />
      {p.kind === 'url' ? (
        <TextInput
          label="Document URL"
          description="Fetched by the server. Private and internal addresses are refused unless the server allows them."
          placeholder="https://api.example.com/openapi.json"
          value={p.url}
          onChange={(e) => p.onUrl(e.currentTarget.value)}
        />
      ) : (
        <>
          {p.kind === 'upload' && (
            <Group>
              <FileButton
                accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                onChange={(file) => {
                  if (file) {
                    void file.text().then((text) => p.onText(text, file.name));
                  }
                }}
              >
                {(props) => (
                  <Button variant="default" leftIcon={<IconFileImport size={16} />} {...props}>
                    Choose file…
                  </Button>
                )}
              </FileButton>
              <Text size="sm" color="dimmed">
                {p.fileName || 'No file chosen'}
              </Text>
            </Group>
          )}
          {p.kind === 'paste' && (
            <Textarea
              aria-label="OpenAPI document"
              placeholder={'openapi: 3.1.0\ninfo:\n  title: …'}
              autosize
              minRows={12}
              maxRows={18}
              value={p.text}
              onChange={(e) => p.onText(e.currentTarget.value)}
              styles={{ input: MONO }}
            />
          )}
        </>
      )}
    </Stack>
  );
}

function OperationRow(p: {
  item: ClassifiedOperation;
  checked: boolean;
  mode: ImportMode;
  onCheck: (checked: boolean) => void;
  onMode: (mode: ImportMode) => void;
}) {
  const { operation, status, match } = p.item;
  const badge = STATUS_BADGE[status];

  return (
    <tr>
      <td>
        <Checkbox
          aria-label={`Import ${operation.method} ${operation.path}`}
          checked={p.checked}
          onChange={(e) => p.onCheck(e.currentTarget.checked)}
        />
      </td>
      <td>
        <MethodBadge method={operation.method} />
      </td>
      <td>
        <Text className="ct-mono" size="xs">
          {finalPath(operation)}
        </Text>
        {operation.summary && (
          <Text size="xs" color="dimmed" lineClamp={1}>
            {operation.summary}
          </Text>
        )}
      </td>
      <td>
        <Text className="ct-mono" size="xs">
          {match ?? operation.endpoint.key}
        </Text>
      </td>
      <td>
        <Group spacing={6} noWrap>
          <Badge variant="light" color={badge.color} radius="sm">
            {badge.label}
          </Badge>
          {operation.deprecated && (
            <Badge variant="outline" color="gray" radius="sm">
              Deprecated
            </Badge>
          )}
        </Group>
      </td>
      <td>
        {status === 'changed' && p.checked && (
          <Select
            aria-label="When the endpoint exists"
            size="xs"
            w={120}
            value={p.mode}
            onChange={(v) => isMode(v) && p.onMode(v)}
            data={MODE_LABELS}
          />
        )}
      </td>
    </tr>
  );
}

function SelectStep(p: {
  classified: readonly ClassifiedOperation[];
  selected: ReadonlySet<string>;
  onSelected: (next: Set<string>) => void;
  modeOf: (key: string) => ImportMode;
  onMode: (key: string, mode: ImportMode) => void;
  defaultMode: ImportMode;
  onDefaultMode: (mode: ImportMode) => void;
}) {
  const [search, setSearch] = useState('');
  const [methods, setMethods] = useState<string[]>([]);
  const needle = search.trim().toLowerCase();
  const visible = p.classified.filter(
    ({ operation: op }) =>
      (methods.length === 0 || methods.includes(op.method)) &&
      (needle === '' ||
        [op.path, op.summary, op.endpoint.key].some((s) => s.toLowerCase().includes(needle))),
  );
  const groups = Map.groupBy(visible, (item) => item.operation.tags[0] ?? 'Untagged');
  const toggle = (keys: readonly string[], checked: boolean) => {
    const next = new Set(p.selected);
    for (const key of keys) {
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
    }
    p.onSelected(next);
  };
  const present = new Set(p.classified.map((c) => c.operation.method));
  const anyChanged = p.classified.some((c) => c.status === 'changed');

  return (
    <Stack spacing="sm">
      <Group spacing="sm" position="apart">
        <Group spacing="sm">
          <TextInput
            aria-label="Search operations"
            placeholder="Search path, summary or key"
            icon={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            w={260}
          />
          <Chip.Group multiple value={methods} onChange={setMethods} spacing={4}>
            {METHODS.filter((m) => present.has(m)).map((m) => (
              <Chip key={m} value={m} size="xs">
                {m}
              </Chip>
            ))}
          </Chip.Group>
        </Group>
        {anyChanged && (
          <Group spacing={6}>
            <Text size="sm" color="dimmed">
              Existing endpoints
            </Text>
            <SegmentedControl
              size="xs"
              value={p.defaultMode}
              onChange={(v) => isMode(v) && p.onDefaultMode(v)}
              data={MODE_LABELS}
            />
          </Group>
        )}
      </Group>
      <div style={{ maxHeight: '48vh', overflow: 'auto' }}>
        <Table verticalSpacing={6} className="ct-table" miw={720}>
          <thead>
            <tr>
              <th style={{ width: 36 }} aria-label="Selected" />
              <th style={{ width: 88 }}>Method</th>
              <th>Path</th>
              <th>Endpoint key</th>
              <th style={{ width: 170 }}>Status</th>
              <th style={{ width: 132 }} aria-label="When it exists" />
            </tr>
          </thead>
          {[...groups].map(([tag, items]) => {
            const keys = items.map((i) => i.operation.operationKey);
            const all = keys.every((k) => p.selected.has(k));
            const some = keys.some((k) => p.selected.has(k));

            return (
              <tbody key={tag}>
                <tr>
                  <td>
                    <Checkbox
                      aria-label={`Select all in ${tag}`}
                      checked={all}
                      indeterminate={some && !all}
                      onChange={(e) => toggle(keys, e.currentTarget.checked)}
                    />
                  </td>
                  <td colSpan={5}>
                    <Text size="sm" weight={650}>
                      {tag}{' '}
                      <Text span color="dimmed" weight={400}>
                        {items.length}
                      </Text>
                    </Text>
                  </td>
                </tr>
                {items.map((item) => (
                  <OperationRow
                    key={item.operation.operationKey}
                    item={item}
                    checked={p.selected.has(item.operation.operationKey)}
                    mode={p.modeOf(item.operation.operationKey)}
                    onCheck={(checked) => toggle([item.operation.operationKey], checked)}
                    onMode={(mode) => p.onMode(item.operation.operationKey, mode)}
                  />
                ))}
              </tbody>
            );
          })}
        </Table>
        {visible.length === 0 && (
          <Text size="sm" color="dimmed" align="center" py="md">
            No operations match.
          </Text>
        )}
      </div>
    </Stack>
  );
}

export function OpenApiImportModal({ opened, onClose, endpoints, baseUrl, onApply }: Props) {
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<SourceKind>('upload');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [url, setUrl] = useState('');
  const [naming, setNaming] = useState<Naming>('operation_id');
  const [bodies, setBodies] = useState(false);
  const [includeDeprecated, setIncludeDeprecated] = useState(false);
  const [pathPrefix, setPathPrefix] = useState('');
  const [server, setServer] = useState<string>(KEEP_BASE_URL);
  const [useAuth, setUseAuth] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [modes, setModes] = useState<ReadonlyMap<string, ImportMode>>(new Map());
  const [defaultMode, setDefaultMode] = useState<ImportMode>('update');
  const blankBase = baseUrl === undefined || pathOf(baseUrl) === undefined;

  const preview = useMutation({
    mutationFn: (options: OpenApiImportOptions) =>
      client.connections.openapiPreview({
        ...options,
        source: kind === 'url' ? { kind: 'url', url: url.trim() } : { kind: 'text', text },
      }),
  });
  const analysis = preview.data;
  const classified = useMemo(
    () => (analysis ? classifyOperations(endpoints, analysis.operations) : []),
    [analysis, endpoints],
  );
  const modeOf = (key: string) => modes.get(key) ?? defaultMode;
  const chosen: ImportedOperation[] = classified
    .filter((c) => selected.has(c.operation.operationKey))
    .map((c) => c.operation);
  const plan = planEndpointImport(endpoints, chosen, (op) => modeOf(op.operationKey));
  const overCapacity = plan.endpoints.length > MAX_ENDPOINTS;

  const options = (patch: Partial<OpenApiImportOptions> = {}): OpenApiImportOptions => ({
    naming,
    bodies: bodies ? 'example' : 'none',
    includeDeprecated,
    pathPrefix,
    ...patch,
  });
  const analyze = (patch: Partial<OpenApiImportOptions> = {}, first = false) =>
    preview.mutate(options(patch), {
      onSuccess: (result) => {
        if (first) {
          const firstServer = result.servers[0];
          const nextServer = blankBase && firstServer !== undefined ? firstServer : KEEP_BASE_URL;
          setServer(nextServer);
          setUseAuth(blankBase && result.auth !== undefined);
          const prefix = nextServer === KEEP_BASE_URL ? suggestedPrefix(firstServer, baseUrl) : '';
          if (prefix !== pathPrefix) {
            setPathPrefix(prefix);
            analyze({ pathPrefix: prefix });

            return;
          }
          setStep(1);
        }
        const statuses = classifyOperations(endpoints, result.operations);
        const keys = new Set(statuses.map((c) => c.operation.operationKey));
        setSelected((previous) =>
          first || ![...previous].some((key) => keys.has(key))
            ? new Set(
                statuses
                  .filter((c) => c.status !== 'unchanged')
                  .map((c) => c.operation.operationKey),
              )
            : new Set([...previous].filter((key) => keys.has(key))),
        );
        if (first) {
          setModes(new Map());
        }
        setStep(1);
      },
    });
  const close = () => {
    setStep(0);
    preview.reset();
    onClose();
  };
  const sourceReady = kind === 'url' ? url.trim() !== '' : text.trim() !== '';
  const sourceIssues = preview.isError ? configIssues(preview.error) : [];

  return (
    <Modal opened={opened} onClose={close} title="Import endpoints from OpenAPI" size="90%">
      <Stack spacing="md">
        <Stepper
          active={step}
          onStepClick={(s) => s < step && setStep(s)}
          breakpoint="sm"
          size="sm"
        >
          <Stepper.Step label="Document" description="Upload, paste or link" />
          <Stepper.Step label="Operations" description="Choose what to import" />
          <Stepper.Step label="Review" description="Apply to the form" />
        </Stepper>

        {step === 0 && (
          <SourceStep
            kind={kind}
            text={text}
            url={url}
            fileName={fileName}
            onKind={(next) => {
              setKind(next);
              preview.reset();
            }}
            onText={(next, name) => {
              setText(next);
              if (name !== undefined) {
                setFileName(name);
              }
              preview.reset();
            }}
            onUrl={(next) => {
              setUrl(next);
              preview.reset();
            }}
          />
        )}

        {step === 1 && analysis && (
          <Stack spacing="sm">
            <Group position="apart" align="flex-end">
              <div>
                <Text weight={650}>
                  {analysis.info.title || 'Untitled API'}{' '}
                  <Text span color="dimmed" weight={400} size="sm">
                    v{analysis.info.version} · OpenAPI {analysis.info.openapi}
                  </Text>
                </Text>
                <Text size="sm" color="dimmed">
                  {countOf(analysis.operations.length, 'operation')} ·{' '}
                  {classified.filter((c) => c.status === 'new').length} new ·{' '}
                  {classified.filter((c) => c.status === 'changed').length} changed ·{' '}
                  {classified.filter((c) => c.status === 'unchanged').length} unchanged
                </Text>
              </div>
            </Group>
            <Warnings warnings={analysis.warnings} />
            <SimpleGrid cols={3} breakpoints={[{ maxWidth: 'md', cols: 1 }]} spacing="sm">
              <Select
                label="Base URL"
                description="The connection's address; endpoint paths are relative to it."
                value={server}
                onChange={(v) => {
                  const next = v ?? KEEP_BASE_URL;
                  setServer(next);
                  const prefix =
                    next === KEEP_BASE_URL ? suggestedPrefix(analysis.servers[0], baseUrl) : '';
                  setPathPrefix(prefix);
                  analyze({ pathPrefix: prefix });
                }}
                data={[
                  {
                    value: KEEP_BASE_URL,
                    label: blankBase ? 'Leave unset' : `Keep ${baseUrl ?? ''}`,
                  },
                  ...analysis.servers.map((s) => ({ value: s, label: s })),
                ]}
              />
              <TextInput
                label="Path prefix"
                description="Added before every path, such as /v1. The Path column shows the result."
                placeholder="none"
                value={pathPrefix}
                onChange={(e) => setPathPrefix(e.currentTarget.value)}
                onBlur={() => analyze()}
              />
              <SegmentedControl
                mt={22}
                value={naming}
                onChange={(v) => {
                  if (isNaming(v)) {
                    setNaming(v);
                    analyze({ naming: v });
                  }
                }}
                data={[
                  { value: 'operation_id', label: 'operationId' },
                  { value: 'summary', label: 'Summary' },
                  { value: 'method_path', label: 'Method + path' },
                ]}
              />
            </SimpleGrid>
            <Group spacing="xl">
              <Switch
                label="Request bodies from examples"
                checked={bodies}
                onChange={(e) => {
                  setBodies(e.currentTarget.checked);
                  analyze({ bodies: e.currentTarget.checked ? 'example' : 'none' });
                }}
              />
              <Switch
                label="Include deprecated"
                checked={includeDeprecated}
                onChange={(e) => {
                  setIncludeDeprecated(e.currentTarget.checked);
                  analyze({ includeDeprecated: e.currentTarget.checked });
                }}
              />
              {analysis.auth && (
                <Switch
                  label={`Use ${analysis.auth.type.replaceAll('_', ' ')} auth from the spec`}
                  checked={useAuth}
                  onChange={(e) => setUseAuth(e.currentTarget.checked)}
                />
              )}
            </Group>
            <SelectStep
              classified={classified}
              selected={selected}
              onSelected={setSelected}
              modeOf={modeOf}
              onMode={(key, mode) => setModes(new Map(modes).set(key, mode))}
              defaultMode={defaultMode}
              onDefaultMode={setDefaultMode}
            />
          </Stack>
        )}

        {step === 2 && analysis && (
          <Alert color="gray" title="Ready to apply">
            <Stack spacing={4}>
              {pathPrefix.trim() !== '' && (
                <Text size="sm">
                  Every path starts with <Code>{pathPrefix.trim()}</Code>, the path prefix you set.
                </Text>
              )}
              {chosen.length > 0 && (
                <div style={{ maxHeight: '32vh', overflow: 'auto' }}>
                  <Table verticalSpacing={4} fontSize="xs" className="ct-table">
                    <thead>
                      <tr>
                        <th style={{ width: 88 }}>Method</th>
                        <th>Saved path</th>
                        <th>Endpoint key</th>
                      </tr>
                    </thead>
                    <tbody>
                      {classified
                        .filter((c) => selected.has(c.operation.operationKey))
                        .map(({ operation, match }) => (
                          <tr key={operation.operationKey}>
                            <td>
                              <MethodBadge method={operation.method} />
                            </td>
                            <td>
                              <Text className="ct-mono" size="xs">
                                {finalPath(operation)}
                              </Text>
                            </td>
                            <td>
                              <Text className="ct-mono" size="xs">
                                {match ?? operation.endpoint.key}
                              </Text>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </Table>
                </div>
              )}
              <Names label="Add" names={plan.added} />
              <Names label="Update" names={plan.updated} />
              <Names label="Unchanged" names={plan.unchanged} />
              <Names label="Skip" names={plan.skipped} />
              {server !== KEEP_BASE_URL && <Text size="sm">Base URL becomes {server}.</Text>}
              {useAuth && analysis.auth && (
                <Text size="sm">
                  Auth becomes {analysis.auth.type.replaceAll('_', ' ')}; fill in its secret before
                  saving.
                </Text>
              )}
              <Text size="sm" color="dimmed" mt="xs">
                Changes go into the form. Save the connection to apply them; endpoints are never
                removed.
              </Text>
            </Stack>
          </Alert>
        )}

        {preview.isError && (
          <Alert color="red" title="Could not read the document">
            {sourceIssues.length > 0
              ? sourceIssues.map((i) => <div key={`${i.path}-${i.message}`}>{i.message}</div>)
              : errorMessage(preview.error)}
          </Alert>
        )}

        <Group position="apart">
          <Text size="sm" color={overCapacity ? 'red' : 'dimmed'}>
            {step > 0 &&
              `${selected.size} selected · ${Math.max(0, MAX_ENDPOINTS - plan.endpoints.length)} of ${MAX_ENDPOINTS} endpoint slots left`}
            {overCapacity && ' · too many endpoints; deselect some'}
          </Text>
          <Group spacing="sm">
            {step > 0 && (
              <Button variant="default" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            {step === 0 && (
              <Button
                disabled={!sourceReady}
                loading={preview.isPending}
                onClick={() => analyze({}, true)}
              >
                Analyze
              </Button>
            )}
            {step === 1 && (
              <Button
                disabled={selected.size === 0 || overCapacity || preview.isPending}
                onClick={() => setStep(2)}
              >
                Review
              </Button>
            )}
            {step === 2 && analysis && (
              <Button
                disabled={overCapacity}
                onClick={() => {
                  onApply({
                    endpoints: plan.endpoints,
                    baseUrl: server === KEEP_BASE_URL ? undefined : server,
                    auth: useAuth ? analysis.auth : undefined,
                    title: analysis.info.title,
                    added: plan.added.length,
                    updated: plan.updated.length,
                  });
                  close();
                }}
              >
                Apply to form
              </Button>
            )}
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
