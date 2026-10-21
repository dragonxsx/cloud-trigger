import {
  Alert,
  Button,
  FileButton,
  Group,
  List,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { CanAccess, useInvalidate } from '@refinedev/core';
import { IconDownload, IconUpload } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { type ApiClient, client } from '../lib/api';
import { errorMessage, notifyError } from '../lib/errors';
import { countOf } from '../lib/format';
import { confirmAction } from './confirm';

type ImportResultDto = Awaited<ReturnType<ApiClient['jobs']['import']>>;
type Mode = 'upsert' | 'replace';
const isMode = (v: string): v is Mode => v === 'upsert' || v === 'replace';

const download = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

function Names({ label, names }: { label: string; names: readonly string[] }) {
  return names.length > 0 ? (
    <Text size="sm">
      <b>{label}:</b> {names.join(', ')}
    </Text>
  ) : null;
}

function Summary({ result }: { result: ImportResultDto }) {
  if (result.issues.length > 0) {
    return (
      <Alert color="red" title="Nothing was imported; fix these first">
        <List size="sm">
          {result.issues.map((i) => (
            <List.Item key={`${i.document}-${i.path}-${i.message}`}>
              Document {i.document + 1}
              {i.name ? ` (${i.name})` : ''}: <b>{i.path}</b> {i.message}
            </List.Item>
          ))}
        </List>
      </Alert>
    );
  }

  return (
    <Alert color="gray" title={result.dryRun ? 'Preview' : 'Imported'}>
      <Names label="Create" names={result.created} />
      <Names label="Update" names={result.updated} />
      <Names label="Delete" names={result.deleted} />
      <Names label="Unchanged" names={result.unchanged} />
    </Alert>
  );
}

export function JobTransferButtons() {
  const [opened, setOpened] = useState(false);
  const [yaml, setYaml] = useState('');
  const [mode, setMode] = useState<Mode>('upsert');
  const invalidate = useInvalidate();
  const exportJobs = useMutation({
    mutationFn: () => client.jobs.export({}),
    onSuccess: (file) => download(file, 'jobs.yaml'),
    onError: (e) => notifyError('Could not export jobs', e),
  });
  const preview = useMutation({
    mutationFn: () => client.jobs.import({ yaml, mode, dryRun: true }),
  });
  const apply = useMutation({
    mutationFn: () => client.jobs.import({ yaml, mode, dryRun: false }),
    onSuccess: async (result) => {
      if (result.issues.length === 0) {
        showNotification({ color: 'green', message: 'Jobs imported' });
        setOpened(false);
      }
      await invalidate({ resource: 'jobs', invalidates: ['list'] });
    },
    onError: (e) => notifyError('Could not import jobs', e),
  });
  const result = apply.data ?? preview.data;
  const resetResults = () => {
    preview.reset();
    apply.reset();
  };
  const applyImport = () => {
    const deleted = preview.data?.deleted ?? [];
    if (mode !== 'replace' || deleted.length === 0) {
      apply.mutate();

      return;
    }
    void confirmAction({
      title: `Delete ${countOf(deleted.length, 'job')}?`,
      message: `Replace mode deletes jobs that are not in the YAML: ${deleted.join(', ')}. This cannot be undone.`,
      confirmLabel: 'Import and delete',
      onConfirm: () => apply.mutate(),
    });
  };
  const loadFile = async (file: File) => {
    setYaml(await file.text());
    resetResults();
  };

  return (
    <>
      <CanAccess resource="jobs" action="export">
        <Button
          variant="default"
          leftIcon={<IconDownload size={16} />}
          loading={exportJobs.isPending}
          onClick={() => exportJobs.mutate()}
        >
          Export YAML
        </Button>
      </CanAccess>
      <CanAccess resource="jobs" action="import">
        <Button
          variant="default"
          leftIcon={<IconUpload size={16} />}
          onClick={() => setOpened(true)}
        >
          Import YAML
        </Button>
      </CanAccess>
      <Modal opened={opened} onClose={() => setOpened(false)} title="Import jobs" size="xl">
        <Stack spacing="md">
          <Text size="sm" color="dimmed">
            Jobs are matched by name. Values shown as *** keep the stored secret. Preview first;
            nothing is written if any document has a problem.
          </Text>
          <Group position="apart">
            <SegmentedControl
              aria-label="Import mode"
              role="radiogroup"
              value={mode}
              onChange={(v) => {
                if (isMode(v)) {
                  setMode(v);
                  resetResults();
                }
              }}
              data={[
                { value: 'upsert', label: 'Create and update' },
                { value: 'replace', label: 'Replace (delete missing)' },
              ]}
            />
            <FileButton
              accept=".yaml,.yml,application/yaml,text/yaml"
              onChange={(file) => {
                if (file) {
                  void loadFile(file);
                }
              }}
            >
              {(props) => (
                <Button variant="subtle" {...props}>
                  Load file…
                </Button>
              )}
            </FileButton>
          </Group>
          <Textarea
            aria-label="YAML"
            autosize
            minRows={10}
            maxRows={20}
            value={yaml}
            onChange={(e) => {
              setYaml(e.currentTarget.value);
              resetResults();
            }}
            styles={{ input: { fontFamily: '"JetBrains Mono Variable", monospace', fontSize: 13 } }}
          />
          {preview.isError && <Alert color="red">{errorMessage(preview.error)}</Alert>}
          {result && <Summary result={result} />}
          <Group position="right">
            <Button
              variant="default"
              disabled={yaml.trim() === ''}
              loading={preview.isPending}
              onClick={() => preview.mutate()}
            >
              Preview
            </Button>
            <Button
              color={mode === 'replace' ? 'red' : 'blue'}
              disabled={!preview.data || preview.data.issues.length > 0}
              loading={apply.isPending}
              onClick={applyImport}
            >
              Apply
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
