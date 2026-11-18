import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['{apps,packages,workers,tests}/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.int.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['{apps,packages,workers,tests}/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          globalSetup: ['./packages/test-utils/src/global-setup.ts'],
          // Integration tests share one database and truncate between tests, so files run serially.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
