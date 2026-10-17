import { contract } from '@cloud-trigger/api-contract';
import { Controller, Get } from '@nestjs/common';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });

@Controller()
export class OpenApiController {
  #spec: Promise<unknown> | undefined;

  @Get('api/openapi.json')
  spec(): Promise<unknown> {
    this.#spec ??= generator.generate(contract, {
      info: {
        title: 'Cloud Trigger API',
        version: '1.0.0',
        description: 'Schedule and trigger remote endpoints.',
      },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
      security: [{ bearer: [] }, { apiKey: [] }],
    });

    return this.#spec;
  }
}
