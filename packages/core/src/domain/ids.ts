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
