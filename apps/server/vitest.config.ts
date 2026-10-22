import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

import shared from '../../vitest.shared.js';

const MONGO = 'test/**/*.mongo.test.ts';

export default defineConfig({
  test: {
    projects: [
      mergeConfig(shared, {
        test: { name: 'unit', exclude: [...configDefaults.exclude, MONGO], hookTimeout: 180_000 },
      }),
      {
        resolve: shared.resolve,
        ssr: shared.ssr,
        test: {
          name: 'mongo',
          include: [MONGO],
          globalSetup: ['test/support/global-mongo.ts'],
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
