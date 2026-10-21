import { useCan } from '@refinedev/core';
import type { ReactNode } from 'react';

import { AccessDenied, PageLoader } from './PageState';

export interface RequireAccessProps {
  readonly resource: string;
  readonly action: string;
  readonly backTo: string;
  readonly backLabel: string;
  readonly children: ReactNode;
}

export function RequireAccess({
  resource,
  action,
  backTo,
  backLabel,
  children,
}: RequireAccessProps) {
  const can = useCan({ resource, action });
  if (can.isLoading) {
    return <PageLoader />;
  }
  if (can.data?.can !== true) {
    return (
      <AccessDenied
        reason={
          can.data?.reason === undefined
            ? undefined
            : `${can.data.reason}. Ask an admin for more access if you need it.`
        }
        action={action}
        backTo={backTo}
        backLabel={backLabel}
      />
    );
  }

  return <>{children}</>;
}
