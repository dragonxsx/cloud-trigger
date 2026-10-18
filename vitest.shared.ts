import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@cloud-trigger/source'] },
  ssr: { resolve: { conditions: ['@cloud-trigger/source'] } },
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
});
