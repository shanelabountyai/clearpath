import { readdirSync, readFileSync, statSync } from 'node:fs';

/**
 * The application's own source, for the structural tests.
 *
 * Some invariants here cannot be tested behaviourally, because the failure mode
 * is code that was never written to be called: a helper that forgets the author
 * filter, or a relation between two models that must never meet. Those are
 * asserted on the shape of the source instead — see `notes/service.test.ts` and
 * `clients/inquiry.test.ts`.
 */
export function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of ['src', 'app']) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      const path = `${dir}/${f}`;
      if (!/\.tsx?$/.test(f) || f.endsWith('.test.ts')) continue;
      if (path.startsWith('src/generated/')) continue;
      if (!statSync(path).isFile()) continue;
      out.push(path);
    }
  }
  return out;
}

/** The argument text of the call starting at `from`, parens balanced. */
export function callArgs(src: string, from: number): string {
  const open = src.indexOf('(', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

export const readSource = (path: string) => readFileSync(path, 'utf8');
