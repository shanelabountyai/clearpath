import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Integration specs share one local Postgres and truncate between tests,
    // so they run in a single file-level sequence rather than racing each other.
    fileParallelism: false,
    hookTimeout: 20_000,
  },
});
