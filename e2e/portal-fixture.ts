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

/**
 * The same door, for a client the practice writes in Spanish. A clinician of
 * its own so the exclusion constraint has nothing to say about two fixtures
 * booking the same hour.
 */
export const ES_TOKEN = 'e2e-portal-token-es-000000';
const ES_CLINICIAN = 'e2e-portal-clinician-es';
export const ES_CLIENT = 'e2e-portal-client-es';
export const ES_NEAR = 'e2e-appt-near-es';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function teardown() {
  const clients = [CLIENT, ES_CLIENT];
  await prisma.outboxMessage.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.portalLink.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.appointment.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.user.deleteMany({ where: { id: { in: [CLINICIAN, ES_CLINICIAN] } } });
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
        // The cadence has already asked. Phase 2 puts it here; this spec is
        // about the answer, not about the asking.
        confirmation: 'pending',
      },
    });
  }
}

async function setupSpanish() {
  const now = Date.now();
  await prisma.user.create({
    // Named like the seeded practice rather than like a fixture: this row is
    // the only one of these that appears in a README picture, and a clinician
    // called "Test Clinician ES" in the middle of it reads as a different kind
    // of claim than the synthetic-data banner is making. Nothing asserts on it.
    data: { id: ES_CLINICIAN, name: 'Mireia Solans', email: 'e2e-portal-es@example.test', role: 'therapist' },
  });
  await prisma.client.create({
    data: {
      id: ES_CLIENT, code: 'TC-E2E-ES', firstName: 'Prueba', lastName: 'Client ES',
      dateOfBirth: new Date('1990-04-12'), treatingClinicianId: ES_CLINICIAN,
      reminderPreference: 'email', language: 'es',
    },
  });
  await prisma.portalLink.create({
    data: { id: 'e2e-portal-link-es', clientId: ES_CLIENT, token: ES_TOKEN, expiresAt: new Date(now + 30 * DAY) },
  });
  // Four hours out: inside the late-cancel window, so declining reaches the
  // fee disclosure — the screen this whole translation exists for.
  await prisma.appointment.create({
    data: {
      id: ES_NEAR, clientId: ES_CLIENT, clinicianId: ES_CLINICIAN,
      startAt: new Date(now + 4 * HOUR),
      endAt: new Date(now + 4 * HOUR + 50 * 60_000),
      modality: 'telehealth', confirmation: 'pending',
    },
  });
}

if (process.argv[2] === 'setup') { await setup(); await setupSpanish(); }
else await teardown();
await prisma.$disconnect();
