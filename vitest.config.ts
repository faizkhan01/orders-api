import { defineConfig } from 'vitest/config';

import { testEnv } from './test/test-env.js';

try {
  // So DATABASE_URL from a local .env can seed the test database name.
  process.loadEnvFile();
} catch {
  // No .env; defaults in test/test-env.ts apply.
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    env: testEnv(),
    // Serial: every integration test truncates the tables, so parallel files would race each other.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
