import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests share one PostgreSQL database; run files one at a time.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: { DEMO_MODE: 'true', NODE_ENV: 'test' },
  },
});
