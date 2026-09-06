/**
 * Why an administrator opened a clinical record, as a code rather than a
 * sentence.
 *
 * Break-glass is the one door from administration into the clinical tier, and
 * every row written while it is open carries this justification into the audit
 * log. That log is the table with the widest readership in the system — the
 * auditor is the only role who may read it, and the only role who may never
 * read a note — and it is append-only by database rule, so anything written
 * into it is there permanently.
 *
 * A free-text box pointed at that table is a channel for clinical content to
 * reach exactly the people the rest of this codebase spends its effort keeping
 * it away from, and the failure is not hypothetical: "client called the
 * practice in distress and their clinician is on leave" is a diagnosis-adjacent
 * statement about a person the same row identifies by id. No filter fixes it
 * either. The outbox deny-list (`messaging/outbox.ts`) catches clinical
 * vocabulary, which is the right tool for a message that must not say *why*
 * someone attends; it cannot catch "Jane rang in tears", which discloses both
 * who and why using none of its words. Hard rule 3 says ids only, and prose
 * cannot be held to that.
 *
 * So the channel is closed instead of filtered. What an auditor actually needs
 * from this field is the category of claim being made — the who, the when and
 * the which-record are already columns on the row — and a category is a closed
 * set. Detail beyond it belongs in the conversation the auditor has with the
 * practice manager, not in an append-only table.
 */

/**
 * The codes, and the sentence each stands for.
 *
 * Every label is operational: it describes the practice's situation, never the
 * client's. "Treating clinician unavailable" is a fact about a rota. "Client in
 * distress" would be a fact about a person, and is why there is no such code.
 */
export const BREAK_GLASS_REASONS = {
  clinician_unavailable: 'Treating clinician is unavailable and care cannot wait',
  client_request: 'The client asked the practice for something in their record',
  records_request: 'Records request from the client or their representative',
  legal_request: 'Court order, subpoena or regulator request',
  billing_query: 'Billing or insurance query that needs the record',
  safety_check: 'Welfare check requested by a family member or another agency',
  data_correction: 'Correcting an administrative error on the record',
} as const;

export type BreakGlassReason = keyof typeof BREAK_GLASS_REASONS;

export const BREAK_GLASS_CODES = Object.keys(BREAK_GLASS_REASONS) as BreakGlassReason[];

export const isBreakGlassReason = (v: unknown): v is BreakGlassReason =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(BREAK_GLASS_REASONS, v);

/** The sentence for a code, for a screen or an export. */
export const breakGlassLabel = (code: BreakGlassReason): string => BREAK_GLASS_REASONS[code];

/**
 * An optional case or ticket identifier beside the code.
 *
 * A subpoena has a docket number and an auditor chasing one will want it, so
 * refusing every character of free input would lose something real. The shape
 * is what makes it safe: no spaces, so it cannot hold a sentence, and 32
 * characters, so it cannot hold a paragraph. "2026-114" fits. "client rang in
 * distress" does not — not because a list of words rejects it, but because it
 * is not the shape of an identifier.
 */
export const BREAK_GLASS_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/;

export const isBreakGlassRef = (v: unknown): v is string =>
  typeof v === 'string' && BREAK_GLASS_REF.test(v);

export interface BreakGlass {
  reason: BreakGlassReason;
  /** A case or ticket id. Never prose — the regex is the whole guarantee. */
  ref?: string;
}

/**
 * Read a break-glass session out of whatever the request carried.
 *
 * The cookie is the trust boundary, not the form: `httpOnly` stops a script in
 * the browser reading it, and stops nothing at all about a request composed by
 * hand. Anything unrecognised here is not an error to report, it is simply not
 * a break-glass session — the caller falls back to their ordinary permissions
 * and is refused in the ordinary way.
 */
export function parseBreakGlass(raw: string | undefined): BreakGlass | undefined {
  if (!raw) return undefined;
  // Split at the *first* colon and keep the whole remainder. `split(':', 2)`
  // would drop everything after the second one, so 'legal_request:2026-114:…'
  // would parse as a valid session with the tail silently thrown away. A
  // boundary that discards what it does not understand is how something
  // unexpected gets treated as something familiar.
  const cut = raw.indexOf(':');
  const reason = cut === -1 ? raw : raw.slice(0, cut);
  const ref = cut === -1 ? undefined : raw.slice(cut + 1);
  if (!isBreakGlassReason(reason)) return undefined;
  if (ref !== undefined && !isBreakGlassRef(ref)) return undefined;
  return ref === undefined ? { reason } : { reason, ref };
}

/** The cookie value for a session. Inverse of `parseBreakGlass`. */
export const serialiseBreakGlass = (bg: BreakGlass): string =>
  bg.ref ? `${bg.reason}:${bg.ref}` : bg.reason;
