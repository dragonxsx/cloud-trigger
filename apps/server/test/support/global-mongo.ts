import { MongoDBContainer } from '@testcontainers/mongodb';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    mongoUri: string;
  }
}

export default async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
  const container = await new MongoDBContainer(process.env['MONGO_IMAGE'] ?? 'mongo:8').start();
  provide('mongoUri', `${container.getConnectionString()}?directConnection=true`);

  return async () => {
    await container.stop();
  };
}
