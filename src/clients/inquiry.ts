import { Conflict } from '../errors';

/**
 * The inquiry lifecycle, in one place (hard rule 8).
 *
 * A caller becomes a client or becomes nothing, and neither is undone. Both
 * endings are terminal for the same reason the session lifecycle's are: one
 * has created a clinical record that now has its own history, and the other is
 * counting down a retention window towards being destroyed. Re-opening either
 * would mean a row whose meaning depends on how it got here.
 */
export type InquiryStatus = 'open' | 'converted' | 'discarded';

export const TRANSITIONS: Record<InquiryStatus, readonly InquiryStatus[]> = {
  open: ['converted', 'discarded'],
  converted: [],
  discarded: [],
};

export const canTransition = (from: InquiryStatus, to: InquiryStatus): boolean =>
  TRANSITIONS[from].includes(to);

/**
 * A wrong move is a refusal, never a silent no-op — the same `Conflict` a
 * session lifecycle violation raises. Silently ignoring `discarded → converted`
 * would leave the caller believing they had a client, and the retention sweep
 * still counting down on the row.
 */
export function assertTransition(from: InquiryStatus, to: InquiryStatus): void {
  if (!canTransition(from, to)) {
    throw new Conflict(`A ${from} inquiry cannot become ${to}`, 'bad_transition');
  }
}
