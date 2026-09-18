'use client';

import { useState, type ReactNode } from 'react';
import { EmptyState, ScrollX } from './primitives';

/**
 * Client search that never leaves the browser (PRD 1, Q2). The page already
 * renders every row the actor may read, so filtering those rows here keeps a
 * typed name out of the URL, history, the server log and any referrer —
 * hard rule 3. Rows arrive pre-rendered from the server; only `text` is read.
 *
 * ponytail: filters the full caseload in memory. If /clients is ever paginated
 * this has to become a server search, sent as a POST body, never a URL.
 */
export function matchesSearch(text: string, term: string): boolean {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function ClientSearch({ rows, head }: {
  rows: { text: string; row: ReactNode }[];
  head: ReactNode;
}) {
  const [term, setTerm] = useState('');
  const shown = rows.filter((r) => matchesSearch(r.text, term));

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <label htmlFor="client-search" className="sr-only">Search clients</label>
        <input
          id="client-search" type="search" value={term} onChange={(e) => setTerm(e.target.value)}
          placeholder="Name or code" autoComplete="off"
          className="rounded-[var(--radius)] border px-2.5 py-1.5 text-body"
          style={{ borderColor: 'var(--border-control)', background: 'var(--surface-raised)' }}
        />
        <p role="status" className="text-caption text-muted">
          {term.trim() ? `${shown.length} of ${rows.length} match` : ''}
        </p>
      </div>

      {shown.length === 0 ? (
        <EmptyState title="No clients match">Try a different name or code.</EmptyState>
      ) : (
        <ScrollX label="Clients" className="rounded-[var(--radius-lg)] border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full min-w-[720px] border-collapse text-body">
            {head}
            <tbody>{shown.map((r) => r.row)}</tbody>
          </table>
        </ScrollX>
      )}
    </>
  );
}
