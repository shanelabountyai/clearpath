import { systemClock } from '../src/clock';
import { prisma } from '../src/db';
import { runInquiryPurge } from '../src/clients/inquiry';
import { runProcessNotePurge } from '../src/staff/departure';

/**
 * `npm run purge:run`. Every retention window in the practice, on one path.
 *
 * Two sweeps with nothing in common except that both destroy rows once a
 * configured window has passed, and that is exactly the reason they share a
 * runner: a second schedule is a second thing to forget, and the one that gets
 * forgotten is the one whose job is to make data stop existing. Intake's build
 * notes made this call and the departure PRD's open question asked for it
 * again.
 *
 * They stay separate functions. Discarded enquiries and a departed clinician's
 * process notes have different windows, different invariants and different
 * triggers refusing them; collapsing them into one query would be the coupling
 * that a shared runner deliberately avoids.
 *
 * Counts only. An id in a log line is a caller, or a note.
 */
const inquiries = await runInquiryPurge(systemClock);
const processNotes = await runProcessNotePurge(systemClock);
console.log(`purged ${inquiries.length} inquiries, ${processNotes.length} process notes`);
await prisma.$disconnect();
