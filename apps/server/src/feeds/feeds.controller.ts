import {
  type FinishedRun,
  GroupId,
  JobId,
  RUN_STATUS_STYLE,
  type Run,
  type SkippedRun,
  TerminalStatus,
} from '@cloud-trigger/core';
import {
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { makeBadge } from 'badge-maker';
import type { Request, Response } from 'express';
import ical from 'ical-generator';
import { z } from 'zod';

import type { AppContext } from '../app-context.js';
import { hasScope } from '../auth/authenticator.js';
import { CalendarTokens } from '../auth/calendar-tokens.js';
import { APP_CONTEXT } from '../tokens.js';

const BadgeParam = z
  .string()
  .regex(/\.svg$/)
  .transform((file) => file.slice(0, -4))
  .pipe(JobId);
const CalendarQuery = z.object({
  tag: z.string().optional(),
  groupId: GroupId.optional(),
  days: z.coerce.number().int().min(1).max(31).default(7),
  token: z.string().optional(),
});

const MAX_EVENTS = 500;

export const headersOf = (req: Request): Headers =>
  new Headers(
    Object.entries(req.headers).flatMap(([name, value]): [string, string][] =>
      value === undefined
        ? []
        : Array.isArray(value)
          ? value.map((v): [string, string] => [name, v])
          : [[name, value]],
    ),
  );

const isFinished = (run: Run): run is FinishedRun | SkippedRun =>
  run.status !== 'pending' && run.status !== 'running';

@Controller()
export class FeedsController {
  readonly #tokens: CalendarTokens;

  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {
    this.#tokens = new CalendarTokens(ctx.config.CALENDAR_TOKEN_SECRET);
  }

  async #requireRead(req: Request, token?: string): Promise<void> {
    if (token !== undefined && this.#tokens.verify(token)) {
      return;
    }
    const principal = await this.ctx.authenticator.authenticate(headersOf(req));
    if (principal === 'missing' || principal === 'invalid') {
      throw new HttpException('Authentication required', HttpStatus.UNAUTHORIZED);
    }
    if (!hasScope(principal, 'read')) {
      throw new HttpException('Requires "read" scope', HttpStatus.FORBIDDEN);
    }
  }

  @Get('badges/jobs/:file')
  @Header('content-type', 'image/svg+xml; charset=utf-8')
  async badge(
    @Param('file') file: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    if (this.ctx.config.BADGES_PUBLIC) {
      res.setHeader('cache-control', 'public, max-age=30');
    } else {
      res.setHeader('cache-control', 'private, no-store');
      await this.#requireRead(req);
    }
    const id = BadgeParam.safeParse(file);
    const job = id.success ? await this.ctx.jobService.get(id.data) : undefined;
    if (!job) {
      return makeBadge({ label: 'job', message: 'not found', color: '#8a93a3' });
    }
    const page = await this.ctx.persistence.runs.list({
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

  @Get('calendar.ics')
  @Header('content-type', 'text/calendar; charset=utf-8')
  @Header('cache-control', 'private, max-age=300')
  async calendar(@Query() raw: Record<string, unknown>, @Req() req: Request): Promise<string> {
    const query = CalendarQuery.safeParse(raw);
    if (!query.success) {
      throw new HttpException(z.prettifyError(query.error), HttpStatus.BAD_REQUEST);
    }
    await this.#requireRead(req, query.data.token);
    const from = new Date();
    const until = new Date(from.getTime() + query.data.days * 86_400_000);
    const fires = await this.ctx.jobService.upcoming({
      tag: query.data.tag,
      groupId: query.data.groupId,
      from,
      until,
      cap: MAX_EVENTS,
    });
    const base = this.ctx.config.PUBLIC_URL;
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
