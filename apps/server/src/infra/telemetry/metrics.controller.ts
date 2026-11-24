import { ResultAsync, err, ok, toError } from '@cloud-trigger/core';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import type { Response } from 'express';

const PROMETHEUS_TEXT = 'text/plain; version=0.0.4; charset=utf-8';

@Controller()
export class MetricsController {
  readonly #serializer = new PrometheusSerializer(undefined, false, undefined, true, true);

  constructor(@Inject(PrometheusExporter) private readonly prometheus: PrometheusExporter) {}

  @Get('metrics')
  async scrape(@Res() response: Response): Promise<void> {
    const collected = await ResultAsync.fromPromise(this.prometheus.collect(), toError).andThen(
      ({ resourceMetrics, errors }) =>
        errors.length === 0
          ? ok(resourceMetrics)
          : err(new Error(errors.map((error) => toError(error).message).join('; '))),
    );
    if (collected.isErr()) {
      response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .type('text/plain')
        .send(`metrics collection failed: ${collected.error.message}`);

      return;
    }
    response.set('content-type', PROMETHEUS_TEXT).send(this.#serializer.serialize(collected.value));
  }
}
