import { createHmac, randomBytes } from 'node:crypto';
import { auditEvent } from '../auth/guard';
import type { Actor } from '../auth/permissions';
import { HOUR, systemClock, type Clock } from '../clock';
import { prisma } from '../db';
import { Prisma } from '../generated/prisma/client';
import { Conflict } from '../errors';
import { createInquiry, type ReferralSource } from './inquiry';

/**
 * The public enquiry form (P2).
 *
 * Everything in this file exists because the PRD called an unauthenticated
 * write "a liability" until rate limiting and spam handling were in front of
 * it. The matrix says an anonymous request may `create` an `inquiry`; this is
 * where that stops being true for the fourth attempt in an hour, for a form
 * the practice has closed, and for a submission with a robot behind it.
 *
 * Three refusals and one silence, and none of them tell the submitter anything
 * about who the practice already knows. There is no `read` in the public row of
 * the matrix, and there is no response here that varies with the database: the
 * form that gets a stranger's enquiry and the form that gets an existing
 * client's look identical from the outside. A public form that says "we already
 * have you" is a client-list oracle for anybody with a phone number to test.
 */

/** Nobody. Never a `User` row, never a session — see the matrix's `public` row. */
export const PUBLIC_ACTOR: Actor = { id: 'public', role: 'public' };

/**
 * What a stranger is allowed to say, and it is deliberately all structured.
 *
 * There is no free-text field here, and its absence is the design. `Inquiry.note`
 * exists for the front desk, where a person hears "I've been having a hard time
 * since my brother died" and types "prefers mornings" — the PRD calls that field
 * the honest weak point, and a textarea on a public counselling form is that
 * weak point with the human filter removed. A box like that would receive a
 * clinical disclosure, not occasionally but as a matter of course, and hard rule
 * 3 says no PHI outside the record. The PRD rejected structured-only fields as
 * unusable "for a person on a phone"; nobody on this form is on a phone.
 *
 * What that costs: a caller who can only do evenings has nowhere to say so, and
 * front desk asks when they ring back. That is the trade, and it is the right
 * way round.
 */
export interface PublicInquiryInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  requestedClinicianId?: string | null;
  referralSource: string;
  /**
   * The honeypot. A field no person sees and no browser autofills, so anything
   * in it came from something reading the HTML.
   */
  website?: string | null;
}

const REFERRAL_SOURCES: readonly string[] = ['gp', 'friend', 'search', 'other'];

/** Generous, but bounded: a trust boundary with no ceiling is a storage bill. */
const MAX = { name: 80, email: 160, phone: 40 } as const;

/**
 * Keyed, not plain-hashed, and never the address itself.
 *
 * A bare SHA-256 of an IPv4 is not anonymisation — the whole space is four
 * billion values and a laptop walks it in minutes, so the table would be a list
 * of everyone who enquired, recoverable by anybody who read it. An HMAC under a
 * secret they do not have is not.
 *
 * Unset in production it throws, the same shape as `clientUrl`'s
 * `CLEARPATH_BASE_URL` guard: a per-process random key still keeps the hashes
 * unrecoverable, but on Vercel every request can land on a different instance,
 * so a silent fallback would throttle each instance separately instead of
 * refusing loudly.
 */
const DEV_FALLBACK_SECRET = randomBytes(32).toString('hex');

function throttleSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLEARPATH_THROTTLE_SECRET) return env.CLEARPATH_THROTTLE_SECRET;
  if (env.NODE_ENV === 'production' || env.CLEARPATH_ALLOW_CLOUD_DB) {
    throw new Error('CLEARPATH_THROTTLE_SECRET is not set: the rate limit would not span instances or restarts');
  }
  return DEV_FALLBACK_SECRET;
}

export const submitterKey = (address: string, env: NodeJS.ProcessEnv = process.env): string =>
  createHmac('sha256', throttleSecret(env)).update(address).digest('base64url');

/**
 * Claim one of this submitter's slots for the hour, or refuse.
 *
 * A fixed window rather than a sliding one, and the slot is claimed before the
 * enquiry is written so a submission that fails on its way to the database
 * still costs its author an attempt.
 *
 * One statement, because the first version was two. It read the row and then
 * wrote it, and ten requests fired together all read an empty window and all ten
 * got through a limit of three. `ON CONFLICT DO UPDATE` takes the row lock, so a
 * burst queues on it and each request sees the count the one before it left. A
 * refusal is the `WHERE` failing, which writes nothing and affects no row.
 */
async function claimSlot(key: string, limit: number, clock: Clock): Promise<boolean> {
  const now = clock.now();
  const spent = Prisma.sql`t."windowStartedAt" <= ${new Date(now.getTime() - HOUR)}`;

  const claimed = await prisma.$executeRaw`
    INSERT INTO "InquiryThrottle" AS t (id, count, "windowStartedAt")
    VALUES (${key}, 1, ${now})
    ON CONFLICT (id) DO UPDATE SET
      count = CASE WHEN ${spent} THEN 1 ELSE t.count + 1 END,
      "windowStartedAt" = CASE WHEN ${spent} THEN EXCLUDED."windowStartedAt" ELSE t."windowStartedAt" END
    WHERE ${spent} OR t.count < ${limit}
  `;
  return claimed === 1;
}

const trim = (v: string | null | undefined, max: number): string =>
  (v ?? '').trim().slice(0, max);

/** Shape only. Deliverability is not this form's business to decide. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+()\-.\s]{7,}$/;

/**
 * Every refusal a submitter can see, as a code. The page looks the code up in
 * its own strings — a message written here would be in one language and would
 * be read in two.
 */
export type PublicInquiryRefusal = 'closed' | 'too_many' | 'invalid';

const refuse = (code: PublicInquiryRefusal) => new Conflict(`Enquiry refused: ${code}`, code);

/**
 * Accept an enquiry from the public form, or refuse it.
 *
 * Returns nothing on success, on purpose: an id handed back is a handle on a
 * row, and the one thing a stranger must not come away holding is a reference
 * to something in this database.
 *
 * Order matters and is not arbitrary. Validation runs before the throttle
 * because it costs no query and a real person who mistypes their email twice
 * must not spend their hour's allowance on typos. The honeypot runs after,
 * because a robot should burn its quota like everybody else — checked first, a
 * bot could hammer the endpoint for ever without the counter ever moving.
 */
export async function submitPublicInquiry(
  input: PublicInquiryInput,
  opts: { address: string; clock?: Clock } = { address: 'unknown' },
): Promise<void> {
  const clock = opts.clock ?? systemClock;
  const settings = await prisma.practiceSettings.findUnique({
    where: { id: 1 },
    select: { publicInquiryEnabled: true, publicInquiryPerHour: true },
  });

  // Off by default, and the kill switch when a flood starts. Logged, because a
  // practice that closed the form wants to know it is still being knocked on.
  if (!settings?.publicInquiryEnabled) {
    await auditEvent(PUBLIC_ACTOR, 'create', 'inquiry', { reason: 'refused:closed', allowed: false });
    throw refuse('closed');
  }

  const firstName = trim(input.firstName, MAX.name);
  const lastName = trim(input.lastName, MAX.name);
  const email = trim(input.email, MAX.email) || null;
  const phone = trim(input.phone, MAX.phone) || null;

  const valid =
    firstName.length > 0 &&
    lastName.length > 0 &&
    // One way to reach them, or the enquiry cannot be answered and is not one.
    (email !== null || phone !== null) &&
    (email === null || EMAIL.test(email)) &&
    (phone === null || PHONE.test(phone)) &&
    REFERRAL_SOURCES.includes(input.referralSource);

  // Not audited, and that is the one refusal here that is not. Hard rule 4
  // wants denials on the record; a malformed request is not a denial of
  // anything — nothing was decided about it and nobody was turned away from a
  // thing they may do. Logging every typo would put noise in the one table
  // whose value is that everything in it means something.
  if (!valid) throw refuse('invalid');

  if (!(await claimSlot(submitterKey(opts.address), settings.publicInquiryPerHour, clock))) {
    await auditEvent(PUBLIC_ACTOR, 'create', 'inquiry', { reason: 'refused:throttled', allowed: false });
    throw refuse('too_many');
  }

  // Caught, counted, and answered with the same screen a real submission gets.
  // Telling a bot it was detected is telling whoever wrote it what to change.
  if (trim(input.website, 200) !== '') {
    await auditEvent(PUBLIC_ACTOR, 'create', 'inquiry', { reason: 'refused:honeypot', allowed: false });
    return;
  }

  // A name they picked off the practice's own website. Resolved rather than
  // trusted — a stale or invented id becomes "no preference" instead of a
  // foreign key error, because a real person's enquiry should not be lost to a
  // clinician who left last month.
  const requested = input.requestedClinicianId
    ? await prisma.user.findFirst({
      where: {
        id: input.requestedClinicianId,
        active: true,
        role: { in: ['therapist', 'associate', 'supervisor'] },
      },
      select: { id: true },
    })
    : null;

  await createInquiry(PUBLIC_ACTOR, {
    firstName,
    lastName,
    email,
    phone,
    requestedClinicianId: requested?.id ?? null,
    referralSource: input.referralSource as ReferralSource,
    referralNote: null,
    // Structured fields only. See `PublicInquiryInput`.
    note: null,
  });
}
