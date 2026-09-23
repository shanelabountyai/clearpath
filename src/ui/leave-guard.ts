'use client';

import { useEffect } from 'react';

/**
 * Asks before anything leaves a page with unsaved text: reload or close
 * (`beforeunload`), an in-app link (capture-phase click, which runs before
 * React's listener so a cancelled click never reaches the router), and the
 * browser's back button (a sentinel history entry, popped when confirmed).
 *
 * ponytail: a guard entry left behind when the text is saved makes the next
 * Back a no-op step on the same URL; add cleanup if that is ever noticed.
 */
export function useLeaveGuard(dirty: boolean, message: string) {
  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => e.preventDefault();
    const click = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href]');
      if (!link || link.getAttribute('target') === '_blank') return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const guard = () => window.history.pushState(window.history.state, '', window.location.href);
    const pop = () => {
      if (window.confirm(message)) {
        window.removeEventListener('popstate', pop);
        window.history.back();
      } else {
        guard();
      }
    };
    guard();
    window.addEventListener('beforeunload', unload);
    window.addEventListener('popstate', pop);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('popstate', pop);
      document.removeEventListener('click', click, true);
    };
  }, [dirty, message]);
}
