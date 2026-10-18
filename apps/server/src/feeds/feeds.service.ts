import {
  type FinishedRun,
  type GroupId,
  JobId,
  type Persistence,
  RUN_STATUS_STYLE,
  type Run,
  type SkippedRun,
  TerminalStatus,
} from '@cloud-trigger/core';
import type { JobService } from '@cloud-trigger/engine';
import { makeBadge } from 'badge-maker';
import ical from 'ical-generator';
import { z } from 'zod';

const BadgeParam = z
  .string()
  .regex(/\.svg$/)
  .transform((file) => file.slice(0, -4))
  .pipe(JobId);

const MAX_EVENTS = 500;

const isFinished = (run: Run): run is FinishedRun | SkippedRun =>
  run.status !== 'pending' && run.status !== 'running';

export interface CalendarFeedQuery {
  readonly tag?: string | undefined;
  readonly groupId?: GroupId | undefined;
  readonly days: number;
}

export class FeedsService {
  constructor(
    private readonly persistence: Persistence,
    private readonly jobService: JobService,
    private readonly publicUrl: string | undefined,
  ) {}

  async badge(file: string): Promise<string> {
    const id = BadgeParam.safeParse(file);
    const job = id.success ? await this.jobService.get(id.data) : undefined;
    if (!job) {
      return makeBadge({ label: 'job', message: 'not found', color: '#8a93a3' });
    }
    const page = await this.persistence.runs.list({
      jobId: job.id,
      status: [...TerminalStatus.options, 'skipped'],
      limit: 1,
    });
    const last = page.items.find(isFinished);
    const style = last ? RUN_STATUS_STYLE[last.status] : { label: 'no runs yet', color: '#b3bac6' };

    return makeBadge({
      label: job.name,
      message:
        job.pausedReason === null
          ? style.label.toLowerCase()
          : `${style.label.toLowerCase()} (paused)`,
      color: style.color,
    });
  }

  async calendar(query: CalendarFeedQuery): Promise<string> {
    const from = new Date();
    const until = new Date(from.getTime() + query.days * 86_400_000);
    const fires = await this.jobService.upcoming({
      tag: query.tag,
      groupId: query.groupId,
      from,
      until,
      cap: MAX_EVENTS,
    });
    const base = this.publicUrl;
    const calendar = ical({ name: 'Cloud Trigger', ttl: 300 });
    for (const fire of fires) {
      calendar.createEvent({
        id: `${fire.job.id}-${fire.at.toISOString()}@cloud-trigger`,
        start: fire.at,
        end: new Date(fire.at.getTime() + 60_000),
        summary: fire.job.name,
        description: fire.description,
        ...(base && { url: new URL(`/jobs/show/${fire.job.id}`, base).toString() }),
      });
    }

    return calendar.toString();
  }
}
