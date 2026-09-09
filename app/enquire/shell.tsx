import type { ReactNode } from 'react';
import { UI, type Language } from '../../src/strings';

const other = (l: Language): Language => (l === 'en' ? 'es' : 'en');

/**
 * The language toggle is a link rather than a picker, and it is at the top.
 *
 * Same reasoning as the dead-link screens in `/f` and `/p`: this is a page
 * whose reader is unknown, and the person least able to act on an English form
 * is exactly the one who would otherwise be handed one.
 */
export function Shell({
  practice, language, children,
}: {
  practice: string; language: Language; children: ReactNode;
}) {
  const ui = UI[language];
  return (
    <main lang={language} className="mx-auto max-w-2xl px-5 py-10">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <p className="text-body tracking-wide text-subtle uppercase">{practice}</p>
        <a href={`/enquire?lang=${other(language)}`} className="text-body underline" lang={other(language)}>
          {ui.enquireOtherLanguage}
        </a>
      </div>
      {children}
      <footer className="mt-12 border-t pt-4 text-caption text-subtle" style={{ borderColor: 'var(--border)' }}>
        {UI[language].footer}
      </footer>
    </main>
  );
}
