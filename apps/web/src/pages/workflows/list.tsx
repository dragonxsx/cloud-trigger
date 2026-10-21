import { Anchor, Badge, Group, Pagination, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { useNavigation, useTable } from '@refinedev/core';
import { EditButton, List } from '@refinedev/mantine';
import { Link } from 'react-router';

import { PageHeading } from '../../components/page-chrome';
import { LoadError } from '../../components/PageState';
import type { WorkflowDto } from '../../lib/api';
import { countOf, fromNow } from '../../lib/format';
import { triggerSummary } from '../../lib/job-summary';

const stepsSummary = (workflow: Pick<WorkflowDto, 'nodes'>): string => {
  const gates = workflow.nodes.filter((node) => node.kind === 'approval').length;
  const steps = countOf(workflow.nodes.length, 'step');

  return gates === 0 ? steps : `${steps} · ${countOf(gates, 'approval gate')}`;
};

export function WorkflowList() {
  const { tableQuery, currentPage, setCurrentPage, pageCount } = useTable<WorkflowDto>({
    resource: 'workflows',
    pagination: { pageSize: 50 },
  });
  const { showUrl } = useNavigation();
  const workflows = tableQuery.data?.data ?? [];

  return (
    <List title={<PageHeading>Workflows</PageHeading>}>
      <Stack spacing="md">
        {tableQuery.isError ? (
          <LoadError
            error={tableQuery.error}
            what="workflows"
            onRetry={() => void tableQuery.refetch()}
          />
        ) : workflows.length === 0 && !tableQuery.isLoading ? (
          <Text color="dimmed" p="lg" align="center">
            No workflows yet. A workflow runs jobs in order, with branches on failure and approval
            gates.
          </Text>
        ) : (
          <ScrollArea>
            <Table highlightOnHover verticalSpacing="xs" className="ct-table" miw={640}>
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Steps</th>
                  <th>Schedule</th>
                  <th>Next run</th>
                  <th>
                    <span className="ct-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {workflows.map((workflow) => (
                  <tr key={workflow.id}>
                    <td>
                      <Group spacing="xs" noWrap>
                        <Anchor
                          component={Link}
                          to={showUrl('workflows', workflow.id)}
                          size="sm"
                          weight={500}
                        >
                          {workflow.name}
                        </Anchor>
                        {!workflow.enabled && (
                          <Badge color="gray" variant="outline" radius="sm" size="sm">
                            Disabled
                          </Badge>
                        )}
                      </Group>
                    </td>
                    <td>
                      <Text size="sm">{stepsSummary(workflow)}</Text>
                    </td>
                    <td>
                      <Text size="sm">
                        {workflow.schedule
                          ? triggerSummary({ trigger: workflow.schedule })
                          : 'Manual only'}
                      </Text>
                    </td>
                    <td>
                      <Text size="sm">{fromNow(workflow.nextFireAt)}</Text>
                    </td>
                    <td>
                      <EditButton
                        resource="workflows"
                        recordItemId={workflow.id}
                        hideText
                        variant="subtle"
                        size="lg"
                        aria-label={`Edit ${workflow.name}`}
                      />
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
