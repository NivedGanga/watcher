import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: './tests/global-setup.ts',
    testTimeout: 30000,
    env: {
      DATABASE_URL: 'mongodb://localhost:27017/agentwatch_test?replicaSet=rs0&directConnection=true',
    },
  },
});
