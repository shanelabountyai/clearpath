# Next

**Item:** P2-1 (delivery receipts) is done, committed and pushed. Nothing is
queued — pick the next thing from
[prd-appointment-confirmation.md](prd-appointment-confirmation.md)'s P2 list, or
start a new PRD.

Three P2s remain, in the order they are worth doing:

1. **Confirmation state feeds the waitlist.** A decline at `d5` is a
   five-day-notice opening, which is exactly what a waitlisted client can take.
   Wiring two existing modules together; no new correctness risk.
2. **Per-client cadence selection** (a client who wants only the day-of nudge).
   Mostly a settings-UI problem on top of `cadenceStages`.
3. **Multi-language message bodies.** The deny-list is English-only and would
   need one per language. Widest surface, lowest leverage.

## What landed this session

**P2-1 — the fee's precondition is a delivery receipt, not an outbox row.**
`OutboxMessage` carries `deliveryState` (`queued → sent → delivered | failed`),
`deliveredAt` and `failureCode` (migration `20260907181137_delivery_receipts`).
New module `src/messaging/delivery.ts` with `dispatchOutbox` and
`recordDeliveryReceipt`; new script `npm run delivery:run`.

- **`nonresponse.ts` splits `mayCharge` into `eligible && reached`.** `reached`
  is `delivered` on at least one reminder — not all three (a bounced `d0` does
  not un-ask a `d5` that landed), and never `sent` (that is still the practice's
  own account of what it did). Silence is recorded either way: delivery is the
  fourth thing that can stop the charge and the fourth that cannot stop the
  write.
- **An undelivered sweep audits as `no_response_undelivered`.** A missing fee
  with no explanation is indistinguishable from a bug.
- **Terminal receipts never move**, in either direction, and a duplicate webhook
  returns `false` rather than throwing.
- **`AppointmentReminder.outboxMessageId` is now a real relation** with
  `@unique` and `onDelete: Restrict` — the evidence cannot be deleted out from
  under the fee.
- **The test helper `asked()` stopped lying.** It now queues a real message and
  records a real receipt, so a spec expecting a fee stands on the row a carrier
  would have written. The whole-loop spec builds its appointment bare and runs
  horizon → dispatch → receipt → sweep.
- **Seed:** one client in the quarter with three `failed` receipts —
  `no_response` + `no_show` + no fee, the only row where those sit together. The
  quarter's fee from silence fell **$270 → $180**, which is the feature working.
  A final `dispatchOutbox` + deliver settles the rest: 173 delivered, 3 failed.

## Gate at this commit

Unit **1577/1577** (was 1561), typecheck clean, e2e **24/24** against the
production build. Migrations applied to dev, test and e2e; both databases
reseeded; `db:status` clean on all three.

No new e2e spec. The gate is arithmetic and state machine, both unit-tested, and
`denials.spec.ts` already crawls `/reports` as every seeded role.

## Deliberately not done

- **No settings flag for "require delivery".** The PRD's Risk 3 says the
  precondition *must* become a receipt; a flag would make the honest behaviour
  optional. The carrier stub is what keeps `delivered` reachable.
- **No "undelivered" column on the confirmation report.** The rate and the fee
  total already move correctly. Add it when somebody asks how often the practice
  fails to reach people — that is a different question from this one.
- **The carrier is still simulated.** What is proven is that the *rule* reads
  delivery, not that any particular message arrived.

## Still open, answered but not actioned

The "refer a friend" growth motion is off — anti-kickback, state
patient-brokering, ethics codes, and a referral program cannot be built without
linking two clients' records. The defensible version is a fixed-list
`referralSource` field at intake: attribution only, no credit, no link between
client records.
