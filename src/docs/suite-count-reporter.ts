import { readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { CLAIMS, verify } from './claims';

/**
 * Checks `README.md`'s test count against the run that just happened.
 *
 * It has to be a reporter rather than a test, because no test can know how many
 * tests there are: `it.each` generates 910 of the permission matrix's cells at
 * collection time, so the number only exists once the run is assembled. The
 * counterpart for the e2e sweep is `e2e/docs-reporter.ts`.
 *
 * A run over a subset — `vitest run src/forms`, or watch mode re-running one
 * file — cannot say anything about the whole suite's size, so the check applies
 * only when every test file on disk took part.
 */
export default class SuiteCountReporter {
  /** Set only by us, so watch mode can take it back when the README catches up. */
  private failed = false;

  onFinished(files: { filepath: string; tasks: Task[] }[] = []) {
    const ran = new Set(files.map((f) => relative(process.cwd(), f.filepath)));
    const onDisk = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => `src/${f}`);
    if (onDisk.some((f) => !ran.has(f))) return; // a partial run counts nothing

    const problems = verify(CLAIMS.unitTests, files.reduce((n, f) => n + count(f.tasks), 0));
    if (!problems.length) {
      if (this.failed) process.exitCode = 0; // a watch run that has since been fixed
      this.failed = false;
      return;
    }
    console.error(`\n✗ README.md is out of date about its own suite:\n  ${problems.join('\n  ')}\n`);
    this.failed = true;
    process.exitCode = 1;
  }
}

type Task = { type: string; tasks?: Task[] };

/** Tests, not suites — and generated cases count individually, which is the point. */
const count = (tasks: Task[]): number =>
  tasks.reduce((n, t) => n + (t.type === 'suite' ? count(t.tasks ?? []) : 1), 0);
