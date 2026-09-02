import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Integration specs share one local Postgres and truncate between tests,
    // so they run in a single file-level sequence rather than racing each other.
    fileParallelism: false,
    // Real-Postgres timings, not unit-test ones: the per-test TRUNCATE and the
    // deliberately-contended booking race are both dominated by WAL fsync, which
    // varies with whatever else the machine is doing. 5s is a coin flip for them.
    hookTimeout: 20_000,
    testTimeout: 20_000,
  },
});
