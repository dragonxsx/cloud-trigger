import { JobId, assertNever } from '@cloud-trigger/core';
import { EventIngestor, type WebhookError } from '@cloud-trigger/engine';
import {
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { flatHeaders } from '../common/http/headers.js';
import { ConfigService } from '../config/config.module.js';

class PayloadTooLarge extends Error {}

async function readBody(req: Request, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit) {
      throw new PayloadTooLarge();
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

const statusFor = (error: WebhookError): HttpStatus => {
  switch (error.code) {
    case 'not_found':
      return HttpStatus.NOT_FOUND;
    case 'unauthorized':
      return HttpStatus.UNAUTHORIZED;
    case 'rate_limited':
      return HttpStatus.TOO_MANY_REQUESTS;
    case 'job_paused':
      return HttpStatus.CONFLICT;
    case 'payload_too_large':
      return HttpStatus.PAYLOAD_TOO_LARGE;
    default:
      return assertNever(error);
  }
};

@Controller('hooks')
export class HooksController {
  constructor(
    @Inject(EventIngestor) private readonly ingestor: EventIngestor,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  @Post(':jobId/:token')
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Param('jobId') rawJobId: string,
    @Param('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ runId: string | null; duplicate: boolean }> {
    const jobId = JobId.safeParse(rawJobId);
    if (!jobId.success) {
      throw new HttpException('No webhook at this address', HttpStatus.NOT_FOUND);
    }
    const body = await readBody(req, this.config.values.WEBHOOK_MAX_BODY_BYTES).catch(
      (error: unknown) => {
        if (error instanceof PayloadTooLarge) {
          throw new HttpException('Payload too large', HttpStatus.PAYLOAD_TOO_LARGE);
        }
        throw error;
      },
    );
    const result = await this.ingestor.receiveWebhook(jobId.data, {
      token,
      headers: flatHeaders(req),
      body,
    });
    if (result.isErr()) {
      if (result.error.code === 'rate_limited') {
        res.setHeader('Retry-After', String(result.error.retryAfterSeconds));
      }
      throw new HttpException(result.error.message, statusFor(result.error));
    }

    return result.value;
  }
}
