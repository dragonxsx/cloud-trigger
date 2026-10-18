import { GroupId } from '@cloud-trigger/core';
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
import type { Request, Response } from 'express';
import { z } from 'zod';

import { Authenticator, hasScope } from '../auth/authenticator.js';
import { CalendarTokens } from '../auth/calendar-tokens.js';
import { headersOf } from '../common/http/headers.js';
import { ConfigService } from '../config/config.module.js';
import { FeedsService } from './feeds.service.js';

const CalendarQuery = z.object({
  tag: z.string().optional(),
  groupId: GroupId.optional(),
  days: z.coerce.number().int().min(1).max(31).default(7),
  token: z.string().optional(),
});

@Controller()
export class FeedsController {
  constructor(
    @Inject(FeedsService) private readonly feeds: FeedsService,
    @Inject(Authenticator) private readonly authenticator: Authenticator,
    @Inject(CalendarTokens) private readonly tokens: CalendarTokens,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async #requireRead(req: Request, token?: string): Promise<void> {
    if (token !== undefined && this.tokens.verify(token)) {
      return;
    }
    const principal = await this.authenticator.authenticate(headersOf(req));
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
    if (this.config.values.BADGES_PUBLIC) {
      res.setHeader('cache-control', 'public, max-age=30');
    } else {
      res.setHeader('cache-control', 'private, no-store');
      await this.#requireRead(req);
    }

    return this.feeds.badge(file);
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

    return this.feeds.calendar(query.data);
  }
}
