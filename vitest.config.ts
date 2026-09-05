import { defineConfig } from 'vitest/config';
import SuiteCountReporter from './src/docs/suite-count-reporter';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // No test can count the suite it is in — the permission matrix alone
    // generates 910 cases at collection time — so README's number is checked
    // by a reporter once the run is assembled.
    reporters: ['default', new SuiteCountReporter()],
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
