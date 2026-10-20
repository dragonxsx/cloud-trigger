import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

export const JobId = z.uuidv7().brand<'JobId'>();
export type JobId = z.output<typeof JobId>;

export const RunId = z.uuidv7().brand<'RunId'>();
export type RunId = z.output<typeof RunId>;

export const GroupId = z.uuidv7().brand<'GroupId'>();
export type GroupId = z.output<typeof GroupId>;

export const newJobId = (): JobId => JobId.parse(uuidv7());
export const newRunId = (): RunId => RunId.parse(uuidv7());
export const newGroupId = (): GroupId => GroupId.parse(uuidv7());

export const NotificationId = z.uuidv7().brand<'NotificationId'>();
export type NotificationId = z.output<typeof NotificationId>;
export const newNotificationId = (): NotificationId => NotificationId.parse(uuidv7());

export const WorkflowId = z.uuidv7().brand<'WorkflowId'>();
export type WorkflowId = z.output<typeof WorkflowId>;
export const newWorkflowId = (): WorkflowId => WorkflowId.parse(uuidv7());

export const WorkflowRunId = z.uuidv7().brand<'WorkflowRunId'>();
export type WorkflowRunId = z.output<typeof WorkflowRunId>;
export const newWorkflowRunId = (): WorkflowRunId => WorkflowRunId.parse(uuidv7());

export const UserId = z.uuidv7().brand<'UserId'>();
export type UserId = z.output<typeof UserId>;
export const newUserId = (): UserId => UserId.parse(uuidv7());

export const ApiKeyId = z.uuidv7().brand<'ApiKeyId'>();
export type ApiKeyId = z.output<typeof ApiKeyId>;
export const newApiKeyId = (): ApiKeyId => ApiKeyId.parse(uuidv7());

export const ConnectionId = z.uuidv7().brand<'ConnectionId'>();
export type ConnectionId = z.output<typeof ConnectionId>;
export const newConnectionId = (): ConnectionId => ConnectionId.parse(uuidv7());

export const EnvironmentId = z.uuidv7().brand<'EnvironmentId'>();
export type EnvironmentId = z.output<typeof EnvironmentId>;
export const newEnvironmentId = (): EnvironmentId => EnvironmentId.parse(uuidv7());
