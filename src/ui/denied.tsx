import type { ReactNode } from 'react';
import { Forbidden } from '../errors';
import { LockedPanel } from './primitives';

/**
 * Renders a denial instead of throwing one.
 *
 * The record pages already caught `Forbidden` and showed a panel; the list
 * pages did not, so every role could reach a crash page by typing a URL it was
 * not entitled to — /audit as a supervisor, /clients as the auditor, /book as
 * the practice manager. The permission matrix was right in all of them and the
 * denial was audit-logged correctly. What was wrong was the last inch: a
 * project whose argument is that refusal is a designed, visible outcome was
 * rendering its refusals as failures.
 *
 * Wrapping the whole component rather than one query is deliberate. A page
 * loads several guarded things — a list, then the names to label it with — and
 * a `try` around the first one leaves the rest able to throw past it.
 *
 * `permissions.test.ts` owns the question of *who* is refused. This owns only
 * what a refusal looks like, and `denials.spec.ts` walks the route tree to
 * check no page is missing it.
 */
export function withDenial<P extends object>(
  Page: (props: P) => Promise<ReactNode>,
  denial: { title: string; children: ReactNode },
) {
  return async function DeniedOr(props: P) {
    try {
      return await Page(props);
    } catch (e) {
      if (!(e instanceof Forbidden)) throw e;
      return (
        <div className="mx-auto max-w-2xl py-8">
          <LockedPanel title={denial.title}>{denial.children}</LockedPanel>
        </div>
      );
    }
  };
}
