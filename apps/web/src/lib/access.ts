import { Me, Scope } from '@cloud-trigger/api-contract';
import { useGetIdentity } from '@refinedev/core';
import { z } from 'zod';

export type ScopeDto = z.output<typeof Scope>;

const Identity = z.object({
  id: z.string(),
  name: z.string(),
  via: Me.shape.via,
  scopes: z.array(Scope),
});
export type IdentityDto = z.output<typeof Identity>;

export const SCOPE_DESCRIPTIONS: Record<ScopeDto, string> = {
  read: 'See jobs, runs, workflows, groups and connections.',
  write: 'Create, edit, run, pause and delete jobs, workflows, groups and connections.',
  admin: 'Manage users, API keys, sign-in methods and environments, and import or export jobs.',
};

export type AccessLevel = 'Admin' | 'Editor' | 'Read-only' | 'No access';

export const LEVEL_LABELS: Record<ScopeDto, AccessLevel> = {
  read: 'Read-only',
  write: 'Editor',
  admin: 'Admin',
};

const lowerFirst = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

export const LEVEL_DESCRIPTIONS: Record<ScopeDto, string> = {
  read: SCOPE_DESCRIPTIONS.read,
  write: `Everything ${LEVEL_LABELS.read} can do, plus: ${lowerFirst(SCOPE_DESCRIPTIONS.write)}`,
  admin: `Everything ${LEVEL_LABELS.write} can do, plus: ${lowerFirst(SCOPE_DESCRIPTIONS.admin)}`,
};

export const NO_ACCESS_DESCRIPTION = 'No access. Ask an admin for access.';

export const topScope = (scopes: readonly ScopeDto[]): ScopeDto | undefined =>
  scopes.includes('admin')
    ? 'admin'
    : scopes.includes('write')
      ? 'write'
      : scopes.includes('read')
        ? 'read'
        : undefined;

export const accessLevel = (scopes: readonly ScopeDto[]): AccessLevel => {
  const top = topScope(scopes);

  return top === undefined ? 'No access' : LEVEL_LABELS[top];
};

export const levelDescription = (scopes: readonly ScopeDto[]): string => {
  const top = topScope(scopes);

  return top === undefined ? NO_ACCESS_DESCRIPTION : LEVEL_DESCRIPTIONS[top];
};

export const levelColor = (scopes: readonly ScopeDto[]): string => {
  const top = topScope(scopes);

  return top === 'admin' ? 'violet' : top === 'write' ? 'blue' : 'gray';
};

export function useIdentity(): { identity: IdentityDto | undefined; isLoading: boolean } {
  const query = useGetIdentity<unknown>();
  const parsed = Identity.safeParse(query.data);

  return { identity: parsed.success ? parsed.data : undefined, isLoading: query.isLoading };
}

export function useHasScope(scope: ScopeDto): boolean | undefined {
  const { identity, isLoading } = useIdentity();
  if (isLoading || !identity) {
    return isLoading ? undefined : false;
  }

  return identity.scopes.includes(scope);
}
