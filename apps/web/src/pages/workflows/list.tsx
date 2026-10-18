import { Pagination, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { useTable } from '@refinedev/core';
import { EditButton, List, ShowButton } from '@refinedev/mantine';

import type { WorkflowDto } from '../../lib/api';
import { fromNow } from '../../lib/format';

export function WorkflowList() {
  const { tableQuery, currentPage, setCurrentPage, pageCount } = useTable<WorkflowDto>({
    resource: 'workflows',
    pagination: { pageSize: 50 },
  });
  const workflows = tableQuery.data?.data ?? [];

  return (
    <List title="Workflows">
      <Stack spacing="md">
        {workflows.length === 0 && !tableQuery.isLoading ? (
          <Text color="dimmed" p="lg" align="center">
            No workflows yet. A workflow runs jobs in order, with branches on failure and approval
            gates.
          </Text>
        ) : (
          <ScrollArea>
            <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={720}>
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Steps</th>
                  <th>Schedule</th>
                  <th>Next run</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {workflows.map((workflow) => (
                  <tr key={workflow.id}>
                    <td>
                      <Text size="sm" weight={500}>
                        {workflow.name}
                      </Text>
                      {!workflow.enabled && (
                        <Text size="xs" color="dimmed">
                          Disabled
                        </Text>
                      )}
                    </td>
                    <td>
                      <Text size="sm">
                        {workflow.nodes.length} steps ·{' '}
                        {workflow.nodes.filter((node) => node.kind === 'approval').length} gates
                      </Text>
                    </td>
                    <td>
                      <Text size="sm" className="ct-mono">
                        {workflow.schedule?.type ?? 'manual'}
                      </Text>
                    </td>
                    <td>
                      <Text size="sm">{fromNow(workflow.nextFireAt)}</Text>
                    </td>
                    <td>
                      <ShowButton hideText size="xs" recordItemId={workflow.id} />
                      <EditButton hideText size="xs" recordItemId={workflow.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </ScrollArea>
        )}
        {pageCount > 1 && (
          <Pagination
            page={currentPage}
            total={pageCount}
            onChange={setCurrentPage}
            position="right"
          />
        )}
      </Stack>
    </List>
  );
}
