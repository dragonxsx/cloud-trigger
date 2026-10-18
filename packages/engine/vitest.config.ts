import { defineConfig, mergeConfig } from 'vitest/config';

import shared from '../../vitest.shared.js';

const integration = (adapter: string) => ({
  extends: true as const,
  test: {
    name: adapter,
    include: ['test/**/*.integration.test.ts'],
    env: { ENGINE_DB: adapter },
  },
});

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      projects: [
        { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'] } },
        integration('mongo'),
        integration('postgres'),
        integration('sqlite'),
      ],
    },
  }),
);
