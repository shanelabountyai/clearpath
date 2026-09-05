import { readdirSync } from 'node:fs';
import { relative } from 'node:path';
import type { FullResult, Reporter, Suite } from '@playwright/test/reporter';
import { CLAIMS, verify } from '../src/docs/claims';

/**
 * Checks `README.md`'s Playwright count against the sweep that just ran — the
 * e2e half of `src/docs/suite-count-reporter.ts`.
 *
 * The number counts tests that *ran*: `screenshots.spec.ts` skips itself
 * outside `npm run shots`, so an ordinary sweep is one fewer than the twenty it
 * collects, and a capture run is a different shape again. Only a full ordinary
 * sweep is in a position to say anything, so a filtered run and `SHOTS=1` both
 * stand down.
 */
export default class DocsReporter implements Reporter {
  private root: Suite | undefined;
  private problems: string[] = [];

  onBegin(_config: unknown, suite: Suite) {
    this.root = suite;
  }

  async onEnd(_result: FullResult) {
    const tests = this.root?.allTests() ?? [];
    const ran = new Set(tests.map((t) => relative(process.cwd(), t.location.file)));
    const onDisk = readdirSync('e2e').filter((f) => f.endsWith('.spec.ts')).map((f) => `e2e/${f}`);
    if (process.env.SHOTS || onDisk.some((f) => !ran.has(f))) return;

    this.problems = verify(CLAIMS.e2eTests, tests.filter((t) => t.outcome() !== 'skipped').length);
    if (!this.problems.length) return;
    return { status: 'failed' as const };
  }

  // Printed last, after Playwright's own summary, so it is the line left on screen.
  async onExit() {
    if (this.problems.length) {
      console.error(`\n✗ README.md is out of date about its own sweep:\n  ${this.problems.join('\n  ')}\n`);
    }
  }
}
