import { prisma } from '../src/db';

/**
 * The one e2e fixture that cannot come from the seed.
 *
 * Everything this spec asserts turns on whether a decline is inside the
 * 24-hour window, which is measured against wall time — and the seeded quarter
 * is pinned to a fixed date, so no seeded row is reliably "two hours from now"
 * on the day the sweep runs.
 *
 * It is written through Prisma rather than as raw SQL on purpose. The pg
 * adapter stores a `Date` as its UTC wall clock labelled in the session's zone;
 * write and read cancel out, so the application is self-consistent, but a row
 * inserted by hand with `now()` reads back skewed by the machine's offset —
 * enough, on a laptop west of Greenwich, for an appointment two hours away to
 * come back as already past and vanish from the client's door.
 */

export const TOKEN = 'e2e-portal-token-0000000000';
const CLINICIAN = 'e2e-portal-clinician';
export const CLIENT = 'e2e-portal-client';
export const NEAR = 'e2e-appt-near';
export const MID = 'e2e-appt-mid';
export const FAR = 'e2e-appt-far';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function teardown() {
  await prisma.outboxMessage.deleteMany({ where: { clientId: CLIENT } });
  await prisma.portalLink.deleteMany({ where: { clientId: CLIENT } });
  await prisma.appointment.deleteMany({ where: { clientId: CLIENT } });
  await prisma.client.deleteMany({ where: { id: CLIENT } });
  await prisma.user.deleteMany({ where: { id: CLINICIAN } });
}

async function setup() {
  await teardown();
  const now = Date.now();

  await prisma.user.create({
    data: { id: CLINICIAN, name: 'Test Clinician', email: 'e2e-portal@example.test', role: 'therapist' },
  });
  await prisma.client.create({
    data: {
      id: CLIENT, code: 'TC-E2E', firstName: 'Test', lastName: 'Client E2E',
      dateOfBirth: new Date('1990-04-12'), treatingClinicianId: CLINICIAN,
      reminderPreference: 'email',
    },
  });
  await prisma.portalLink.create({
    data: { id: 'e2e-portal-link', clientId: CLIENT, token: TOKEN, expiresAt: new Date(now + 30 * DAY) },
  });

  // Telehealth, so the room exclusion constraint has nothing to collide over,
  // and a clinician of its own, so neither does the clinician one.
  for (const [id, offset] of [[NEAR, 2 * HOUR], [MID, 3 * DAY], [FAR, 5 * DAY]] as const) {
    await prisma.appointment.create({
      data: {
        id, clientId: CLIENT, clinicianId: CLINICIAN,
        startAt: new Date(now + offset),
        endAt: new Date(now + offset + 50 * 60_000),
        modality: 'telehealth',
        // Booked a month back, which is the notice a `pending` row implies —
        // the cadence will not promote one without the time to have asked.
        createdAt: new Date(now - 30 * DAY),
        bookedAt: new Date(now - 30 * DAY),
        // The cadence has already asked. Phase 2 puts it here; this spec is
        // about the answer, not about the asking.
        confirmation: 'pending',
      },
    });
  }
}

if (process.argv[2] === 'setup') await setup();
else await teardown();
await prisma.$disconnect();
