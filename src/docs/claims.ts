import { readFileSync } from 'node:fs';

/**
 * The numbers the documents quote, and where each one is derived from.
 *
 * `README.md`, `WRITEUP.md` and the PRD all state sizes — how many tests run,
 * how many cells the permission matrix has — and every one of them was written
 * by hand and has already gone stale once. Commit bb729ca corrected three of
 * them by reading the suite; nothing then stopped the next edit from doing it
 * again, and `README.md` was quoting 1,252 tests against a suite that had grown
 * past it by the time anyone looked.
 *
 * So each claim names the sentence that makes it, and the run or the module
 * that settles it. A claim whose pattern no longer matches its document is a
 * failure too, and that is the whole point: a check that quietly stops finding
 * the sentence it guards is the same broken thing as the assertion this file
 * was written to replace, which read
 *
 *     it('covers 455 cells', () =>
 *       expect(cells).toHaveLength(ROLES.length * RESOURCES.length * ACTIONS.length))
 *
 * and would have passed at any size, because `cells` is built from exactly that
 * product. The only place the number 455 actually appeared was the test's name.
 */
export type Claim = {
  /** What the number counts, for the failure message. */
  what: string;
  /** Every sentence that states it: one capture group, the number. */
  sites: { file: string; pattern: RegExp }[];
};

export const CLAIMS = {
  unitTests: {
    what: 'unit + integration tests (npm test)',
    sites: [{ file: 'README.md', pattern: /^npm test\s+# ([\d,]+) unit \+ integration tests$/m }],
  },
  e2eTests: {
    what: 'Playwright tests (npm run test:e2e)',
    sites: [{ file: 'README.md', pattern: /^npm run test:e2e\s+# ([\d,]+) Playwright tests\b/m }],
  },
  matrixCells: {
    what: 'permission matrix cells (role × resource × action)',
    sites: [
      { file: 'WRITEUP.md', pattern: /All ([\d,]+) cells are enumerated/ },
      { file: 'prd-clearpath-counseling-ops.md', pattern: /asserts all ([\d,]+) cells/ },
    ],
  },
} as const satisfies Record<string, Claim>;

/**
 * Every way a claim can be wrong, as sentences. Empty means the documents and
 * the product agree.
 */
export function verify(claim: Claim, actual: number): string[] {
  return claim.sites.flatMap(({ file, pattern }) => {
    const found = readFileSync(file, 'utf8').match(pattern);
    if (!found) {
      return [
        `${file}: no sentence matching ${pattern} — the claim about ${claim.what} was ` +
          `reworded or removed. Update the pattern in src/docs/claims.ts, or drop the claim.`,
      ];
    }
    const stated = Number(found[1]!.replace(/,/g, ''));
    return stated === actual
      ? []
      : [`${file}: says ${found[1]} ${claim.what}; there are ${actual.toLocaleString('en-US')}.`];
  });
}

/** Throw with every mismatch at once, rather than one per run. */
export function assertClaim(claim: Claim, actual: number): void {
  const problems = verify(claim, actual);
  if (problems.length) throw new Error(`Documented count is out of date:\n  ${problems.join('\n  ')}`);
}
