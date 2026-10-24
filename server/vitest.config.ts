import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: './tests/global-setup.ts',
    testTimeout: 30000,
    env: {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5433/agentwatch_test',
    },
  },
});
