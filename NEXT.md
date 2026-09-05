# Next

**Item:** Build the appointment confirmation loop — [prd-appointment-confirmation.md](prd-appointment-confirmation.md).

Start at **Phase 1 (the fact)**: P0-1 and P0-2 plus the migration
(`confirmation`, `AppointmentReminder`, `noShowFeeCents`, waiver columns).
Pure logic first per the project's TDD order — `confirmationRequired` with
every eligibility cell, especially the `reminderPreference: 'none'` denials —
then the stage due-time function. Nothing persists until both are green.

Three product questions are answered and recorded in the PRD (Q1 both/link
first, Q2 fee ships with flag on, Q3 noShowFeeCents = 9000). Q4–Q7 are open
but none of them block Phase 1.

Gate was green at the last commit: unit 1252/1252, e2e 18 passed + 1 skipped.
