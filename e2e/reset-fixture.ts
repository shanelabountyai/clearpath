import { rmSync } from 'node:fs';
import { prisma } from '../src/db';
import { systemClock } from '../src/clock';
import { DEV_MAIL_DIR } from '../src/auth/mailer';
import { setPassword } from '../src/auth/sessions';
import { generateSecret } from '../src/auth/totp';

/**
 * Three accounts of this spec's own, and why it does not borrow the seed's.
 *
 * Completing a reset revokes every session the account had — that is the point
 * of it — and the sweep caches one token per person for the whole run. Resetting
 * Marion Whitlock's password would end a session four spec files are still
 * holding, and the failure would surface as a calendar page redirecting to the
 * login screen with nothing connecting it back. So these three exist only for
 * the reset specs, and one of them is the case the seed cannot contain at all:
 * a clinical account that has never enrolled, and can therefore never be sent a
 * link.
 */

export const PASSWORD = 'reset-spec-passphrase';
export const NEW_PASSWORD = 'reset-spec-new-passphrase';

export const DESK = { id: 'e2e-reset-desk', name: 'Reset Desk', email: 'e2e-reset-desk@example.test' };
export const CLINICAL = { id: 'e2e-reset-clinical', name: 'Reset Clinician', email: 'e2e-reset-clinical@example.test' };
export const UNENROLLED = { id: 'e2e-reset-unenrolled', name: 'Reset Unenrolled', email: 'e2e-reset-unenrolled@example.test' };

const ALL = [DESK, CLINICAL, UNENROLLED];

async function teardown() {
  const ids = ALL.map((u) => u.id);
  await prisma.passwordReset.deleteMany({ where: { userId: { in: ids } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
  // The audit rows these accounts leave behind are deliberately *not* removed.
  // `AuditEvent` is append-only by a database rule, and the rule caught the
  // first draft of this line — which is the rule doing its job rather than an
  // inconvenience. `actorId` is a plain column with no foreign key precisely so
  // that a trail outlives the account it names, and a suite that could tidy the
  // log would be a suite proving something weaker than the one that cannot.
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  // The dev mailer's outbox is a directory of links. Leaving them behind would
  // let one run's `latestResetLink` answer with the previous run's token.
  rmSync(DEV_MAIL_DIR, { recursive: true, force: true });
}

async function setup() {
  await teardown();
  const deps = { clock: systemClock };

  await prisma.user.create({ data: { ...DESK, role: 'front_desk' } });
  await prisma.user.create({ data: { ...CLINICAL, role: 'therapist' } });
  await prisma.user.create({ data: { ...UNENROLLED, role: 'therapist' } });
  for (const u of ALL) await setPassword(u.id, PASSWORD, deps);

  // Enrolled directly rather than through the enrolment screen. What this spec
  // is about starts after somebody already has a second factor, and driving the
  // set-up flow again would only re-test the previous phase — and would spend a
  // TOTP step the reset spec then has to wait out.
  await prisma.user.update({
    where: { id: CLINICAL.id },
    data: { totpSecret: generateSecret(), totpEnrolledAt: new Date() },
  });
}

if (process.argv[2] === 'setup') await setup();
else await teardown();
await prisma.$disconnect();
