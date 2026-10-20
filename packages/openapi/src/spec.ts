import { z } from 'zod';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export const UNSUPPORTED_METHODS = ['trace', 'query'] as const;

const Examples = z.record(z.string(), z.unknown()).optional();

export const SchemaHints = z.looseObject({
  example: z.unknown().optional(),
  default: z.unknown().optional(),
  examples: z.array(z.unknown()).optional(),
});

export const Parameter = z.looseObject({
  name: z.string(),
  in: z.string(),
  required: z.boolean().default(false),
  schema: z.unknown().optional(),
  example: z.unknown().optional(),
  examples: Examples,
});
export type Parameter = z.output<typeof Parameter>;

export const MediaType = z.looseObject({
  schema: z.unknown().optional(),
  example: z.unknown().optional(),
  examples: Examples,
});

export const RequestBody = z.looseObject({
  content: z.record(z.string(), MediaType).default({}),
});

export const Server = z.looseObject({
  url: z.string(),
  variables: z.record(z.string(), z.looseObject({ default: z.unknown() })).default({}),
});
export type Server = z.output<typeof Server>;

export const Operation = z.looseObject({
  operationId: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  deprecated: z.boolean().default(false),
  parameters: z.array(z.unknown()).default([]),
  requestBody: z.unknown().optional(),
  servers: z.array(Server).optional(),
});
export type Operation = z.output<typeof Operation>;

export const PathItem = z.looseObject({
  parameters: z.array(z.unknown()).default([]),
  servers: z.array(Server).optional(),
  additionalOperations: z.record(z.string(), z.unknown()).optional(),
});

export const SecurityScheme = z.looseObject({
  type: z.string(),
  scheme: z.string().optional(),
  in: z.string().optional(),
  name: z.string().optional(),
  flows: z
    .looseObject({
      clientCredentials: z
        .looseObject({
          tokenUrl: z.string(),
          scopes: z.record(z.string(), z.unknown()).default({}),
        })
        .optional(),
    })
    .optional(),
});
export type SecurityScheme = z.output<typeof SecurityScheme>;

export const OpenApiDocument = z.looseObject({
  openapi: z.string(),
  info: z
    .looseObject({ title: z.string().default(''), version: z.string().default('') })
    .prefault({}),
  servers: z.array(z.unknown()).default([]),
  paths: z.record(z.string(), z.unknown()).default({}),
  security: z.array(z.record(z.string(), z.unknown())).default([]),
  components: z
    .looseObject({ securitySchemes: z.record(z.string(), z.unknown()).default({}) })
    .prefault({}),
});
export type OpenApiDocument = z.output<typeof OpenApiDocument>;
