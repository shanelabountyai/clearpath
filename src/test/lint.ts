/**
 * The shared half of the structural lints.
 *
 * This project has several greps over `src/` and `app/` that fail the build on
 * a shape rather than on a behaviour — no role check outside `permissions.ts`,
 * no process-note query without an author, no `no_show` write outside
 * `lifecycle.ts`, no path to a non-response fee that has not asked whether it
 * may charge. They exist because a behavioural test can say nothing about the
 * helper written next month, and three of them have money or privacy attached.
 *
 * They all ran into the same problem at the same time: a report that *reads*
 * `status: 'no_show'` looks exactly like a handler that *writes* it. A lint
 * that cannot tell those apart either fails on every report or passes on every
 * backfill, and both make it worthless. So the distinction lives here, once.
 */

/**
 * Occurrences of `field: 'value'` that assert the value rather than look for it.
 *
 * Decided from the brace stack: an occurrence inside a `where` block is a
 * filter, and anything else — a `data:` payload, an option handed to a
 * function — is the application deciding something. That makes it a fact about
 * the code's structure rather than a guess about the line, which matters
 * because the alternative heuristics (nearest keyword, same-line `data:`) both
 * get the multi-line Prisma call wrong.
 *
 * It is not a parser and does not pretend to be: a brace inside a string
 * literal would confuse it. Nothing in this codebase writes one, and the cost
 * of being wrong is a spurious build failure, which is the safe direction for
 * a lint whose whole job is to be paranoid.
 */
export function assertsLiteral(source: string, field: string, value: string): number {
  const pattern = new RegExp(`^${field}:\\s*['"\`]${value}`);
  const labels: string[] = [];
  let count = 0;

  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') {
      // The identifier this block hangs off: `where: {`, `data: {`, `select: {`.
      labels.push(/([A-Za-z_$][\w$]*)\s*:\s*$/.exec(source.slice(Math.max(0, i - 40), i))?.[1] ?? '');
    } else if (source[i] === '}') {
      labels.pop();
    } else if (pattern.test(source.slice(i, i + field.length + value.length + 4))) {
      if (!labels.includes('where')) count++;
    }
  }
  return count;
}
