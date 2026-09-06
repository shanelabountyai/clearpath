import Link from 'next/link';
import { requireSession } from '../../../src/session';
import { daySchedule, type DaySession } from '../../../src/scheduling/calendar';
import { groupStatus, layoutTracks } from '../../../src/scheduling/dayview';
import type { Status } from '../../../src/scheduling/lifecycle';
import { addDays, localDateOf, minutesToHHMM, WEEKDAYS, weekdayOf } from '../../../src/time';
import { AppointmentChip, PageHeader, TierBanner } from '../../../src/ui/primitives';
import { systemClock } from '@/src/clock';
import { withDenial } from '@/src/ui/denied';

export const dynamic = 'force-dynamic';

const DAY_START = 8 * 60;
const DAY_END = 19 * 60;
const PX_PER_MIN = 1.15;

async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { actor } = await requireSession();
  const params = await searchParams;
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : localDateOf(systemClock.now());
  const day = await daySchedule(actor, date);

  const byRoom = new Map<string, DaySession[]>();
  const telehealth: DaySession[] = [];
  for (const s of day.sessions) {
    if (s.modality === 'telehealth' || !s.roomId) telehealth.push(s);
    else byRoom.set(s.roomId, [...(byRoom.get(s.roomId) ?? []), s]);
  }

  const hours: number[] = [];
  for (let m = DAY_START; m <= DAY_END; m += 60) hours.push(m);

  // Two numbers, because a group makes them differ. `sessions` counts client
  // sessions — six people in a skills group are six sessions, six notes, six
  // fees, and that is the number the practice runs on. `bookings` counts what
  // is drawn: six attendees share one hour in one room, so they are one chip.
  // Front desk counting seventeen chips under a heading that says twenty-two
  // has to find the `×6` and do the arithmetic to reconcile them, and a caption
  // that needs arithmetic is a caption that gets ignored. Said only when they
  // differ, because on a day with no group it is the same number twice.
  const bookings = new Set(day.sessions.map((s) => s.groupSessionId ?? s.id)).size;
  const count = bookings === day.sessions.length
    ? `${day.sessions.length} sessions`
    : `${day.sessions.length} sessions in ${bookings} bookings`;

  return (
    <>
      <PageHeader
        title={`${WEEKDAYS[weekdayOf(date)]}, ${date}`}
        subtitle={`${count} · ${day.rooms.length} rooms`}
        actions={
          <div className="flex items-center gap-1.5">
            <DayLink date={addDays(date, -1)} label="← Previous" />
            <DayLink date={localDateOf(systemClock.now())} label="Today" />
            <DayLink date={addDays(date, 1)} label="Next →" />
          </div>
        }
      />

      <div className="mb-4">
        <TierBanner tier="operational">
          Names, times and rooms. Why anyone is here does not appear on this screen at
          any level of detail.
        </TierBanner>
      </div>

      {day.absences.length > 0 && (
        <p
          className="mb-4 rounded-[var(--radius)] border px-3 py-2 text-body"
          style={{ borderColor: 'var(--warning)', background: 'var(--warning-soft)' }}
        >
          <span aria-hidden>⚠ </span>
          {day.absences
            .map((a) => {
              const who = day.clinicians.find((c) => c.id === a.userId)?.name ?? 'A clinician';
              // An hour missing from the middle of a day is a different fact
              // from a day off, and front desk acts on it differently.
              const when = a.allDay
                ? 'away today'
                : `out ${a.lost.map((w) => `${minutesToHHMM(w.startMinute)}–${minutesToHHMM(w.endMinute)}`).join(', ')}`;
              return `${who} ${when} (${a.reason})`;
            })
            .join('; ')}
          . <Link className="underline" href="/worklists">See the reschedule work-list</Link>.
        </p>
      )}

      <div className="scroll-x rounded-[var(--radius-lg)] border" style={{ borderColor: 'var(--border)' }}>
        <div className="flex min-w-[860px]">
          {/* Time gutter */}
          <div className="w-14 shrink-0 border-r" style={{ borderColor: 'var(--border)' }}>
            <div className="h-9 border-b" style={{ borderColor: 'var(--border)' }} />
            <div className="relative" style={{ height: (DAY_END - DAY_START) * PX_PER_MIN }}>
              {hours.map((m) => (
                <div
                  key={m}
                  className="absolute right-2 -translate-y-1/2 font-mono text-nano text-subtle"
                  style={{ top: (m - DAY_START) * PX_PER_MIN }}
                >
                  {minutesToHHMM(m)}
                </div>
              ))}
            </div>
          </div>

          {day.rooms.map((room) => (
            <Column key={room.id} title={room.name} subtitle="In person" sessions={byRoom.get(room.id) ?? []} hours={hours} />
          ))}

          {/* The telehealth lane belongs to no room. That is the entire point of
              the conditional resource, made visible: a full room map does not
              block a video session. */}
          <Column
            title="Telehealth"
            subtitle="No room needed"
            accent
            sessions={telehealth}
            hours={hours}
          />
        </div>
      </div>
    </>
  );
}

function DayLink({ date, label }: { date: string; label: string }) {
  return (
    <Link
      href={`/calendar?date=${date}`}
      className="rounded-[var(--radius)] border px-2.5 py-1 text-caption transition-colors hover:bg-[var(--surface-inset)]"
      style={{ borderColor: 'var(--border)' }}
    >
      {label}
    </Link>
  );
}

function Column({
  title, subtitle, sessions, hours, accent,
}: {
  title: string; subtitle: string; sessions: DaySession[]; hours: number[]; accent?: boolean;
}) {
  // Collapse first, then lay out: six attendees of one group are one chip
  // occupying one hour, and it is the chips that must not land on top of each
  // other.
  const chips = collapseGroups(sessions);
  const tracks = layoutTracks(chips.map(({ session }) => session));
  // A lane that has to hold two sessions at once gets the width of two, rather
  // than cutting a name in half to fit. Room columns are always one; only the
  // telehealth lane can grow, and the grid already scrolls sideways.
  const lanes = Math.max(1, ...[...tracks.values()].map((t) => t.of));
  return (
    <div
      className="flex-1 border-r last:border-r-0"
      style={{ borderColor: 'var(--border)', minWidth: 150 * lanes, flexGrow: lanes }}
    >
      <div
        className="flex h-9 flex-col justify-center border-b px-2"
        style={{
          borderColor: 'var(--border)',
          background: accent ? 'var(--accent-soft)' : 'var(--surface-sunken)',
        }}
      >
        <span className="text-caption font-semibold leading-tight">{title}</span>
        <span className="text-nano leading-tight text-subtle">{subtitle}</span>
      </div>
      <div className="relative" style={{ height: (hours[hours.length - 1]! - hours[0]!) * PX_PER_MIN + 60 }}>
        {hours.map((m) => (
          <div
            key={m}
            className="absolute inset-x-0 border-t"
            style={{ top: (m - hours[0]!) * PX_PER_MIN, borderColor: 'var(--border)', opacity: 0.55 }}
          />
        ))}
        {chips.map(({ session: s, group }) => (
          <AppointmentChip
            key={s.id}
            session={s}
            group={group}
            track={tracks.get(s.id)}
            top={(s.startMinute - hours[0]!) * PX_PER_MIN}
            height={(s.endMinute - s.startMinute) * PX_PER_MIN - 3}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One chip per booking, not one per attendee.
 *
 * A group session is N appointment rows in the same room at the same time, so
 * drawn literally it is N chips stacked on the same pixels — which is exactly
 * what a double-booking looks like. Front desk needs to see one hour with six
 * people in it, and open the roster from there.
 */
function collapseGroups(sessions: DaySession[]) {
  const attendees = new Map<string, DaySession[]>();
  for (const s of sessions) {
    if (s.groupSessionId) attendees.set(s.groupSessionId, [...(attendees.get(s.groupSessionId) ?? []), s]);
  }
  const drawn = new Set<string>();
  const out: {
    session: DaySession;
    group?: { id: string; topic: string | null; count: number; status: Status };
  }[] = [];
  for (const s of sessions) {
    if (!s.groupSessionId) {
      out.push({ session: s });
      continue;
    }
    if (drawn.has(s.groupSessionId)) continue;
    drawn.add(s.groupSessionId);
    const roster = attendees.get(s.groupSessionId) ?? [s];
    out.push({
      session: s,
      group: {
        id: s.groupSessionId,
        topic: s.groupSession?.topic ?? null,
        count: roster.length,
        // Every field the chip paints itself with has to come from the whole
        // roster, or the hour wears one attendee's morning.
        status: groupStatus(roster.map((a) => a.status)),
      },
    });
  }
  return out;
}

export default withDenial(CalendarPage, {
  title: 'The schedule',
  children:
    'Who is booked, when and in which room is operational rather than clinical — but it is still the practice’s, and the audit role reads the log instead.',
});
