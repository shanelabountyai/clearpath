import { defineConfig, devices } from '@playwright/test';

/**
 * e2e runs against a production build, not the dev server: four times faster,
 * a quarter the memory, and — the reason it stays — a dev server is not the
 * artifact that ships. Set E2E_DEV=1 to debug one spec against `next dev`.
 */
const PORT = Number(process.env.PORT ?? 3700);
const dev = process.env.E2E_DEV === '1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // The demo gate is on in the production build the sweep runs against.
    // Playwright sends these only in answer to a Basic challenge.
    httpCredentials: process.env.DEMO_ACCESS_PASSWORD
      ? { username: 'demo', password: process.env.DEMO_ACCESS_PASSWORD }
      : undefined,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build and serve in one command, so a stale .next cannot quietly test
    // yesterday's code.
    command: dev ? 'npm run dev:e2e' : 'npm run e2e:server',
    port: PORT,
    reuseExistingServer: false,
    // A cold production build exceeds the 120s default on its own.
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
