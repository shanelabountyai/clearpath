import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTIONS, RESOURCES, ROLES } from '../auth/permissions';
import { CLAIMS, verify } from './claims';

describe('the documents quote the product, not a memory of it', () => {
  it('states the real size of the permission matrix', () => {
    expect(verify(CLAIMS.matrixCells, ROLES.length * RESOURCES.length * ACTIONS.length)).toEqual([]);
  });

  /**
   * The two suite-size claims are settled by the runs themselves — see
   * `suite-count-reporter.ts` and `e2e/docs-reporter.ts` — and neither reporter
   * can complain about a sentence it can no longer find. Reword the README's
   * install block and both checks would go quiet rather than red, which is the
   * failure this whole file exists to stop happening a third time.
   */
  it.each(Object.entries(CLAIMS).flatMap(([name, c]) => c.sites.map((s) => [name, s] as const)))(
    'still finds the sentence behind %s in %o',
    (_name, site) => {
      expect(readFileSync(site.file, 'utf8')).toMatch(site.pattern);
    },
  );
});
