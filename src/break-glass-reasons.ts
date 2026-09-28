/**
 * Why somebody broke glass — a fixed list, never free text (review #2).
 *
 * The reason lands in the audit log, its CSV export and the cookie, and the
 * audit log is read by the one role that may not open a record. A text box
 * there invites exactly what hard rule 3 forbids: "client X called about her
 * overdose" is PHI in the table that is supposed to hold ids only.
 */
export const BREAK_GLASS_REASONS = {
  client_crisis: 'Client in crisis and their clinician is unreachable',
  safeguarding: 'Safeguarding or duty-to-warn concern',
  continuity_of_care: 'Continuity of care: clinician absent, client needs care now',
  records_request: 'Legal or records request that cannot wait',
} as const;

export type BreakGlassReason = keyof typeof BREAK_GLASS_REASONS;

export const isBreakGlassReason = (v: string): v is BreakGlassReason => Object.hasOwn(BREAK_GLASS_REASONS, v);
