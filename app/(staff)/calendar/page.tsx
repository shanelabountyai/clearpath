import Link from 'next/link';
import { requireSession } from '../../../src/session';
import { daySchedule, type DaySession } from '../../../src/scheduling/calendar';
import { addDays, localDateOf, minutesToHHMM, WEEKDAYS, weekdayOf } from '../../../src/time';
import { PageHeader, STATUS_META, TierBanner } from '../../../src/ui/primitives';

export const dynamic = 'force-dynamic';

const DAY_START = 8 * 60;
const DAY_END = 19 * 60;
const PX_PER_MIN = 1.15;

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { actor } = await requireSession();
  const params = await searchParams;
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : localDateOf(new Date());
  const day = await daySchedule(actor, date);

  const byRoom = new Map<string, DaySession[]>();
  const telehealth: DaySession[] = [];
  for (const s of day.sessions) {
    if (s.modality === 'telehealth' || !s.roomId) telehealth.push(s);
    else byRoom.set(s.roomId, [...(byRoom.get(s.roomId) ?? []), s]);
  }

  const hours: number[] = [];
  for (let m = DAY_START; m <= DAY_END; m += 60) hours.push(m);

  return (
    <>
      <PageHeader
        title={`${WEEKDAYS[weekdayOf(date)]}, ${date}`}
        subtitle={`${day.sessions.length} sessions · ${day.rooms.length} rooms`}
        actions={
          <div className="flex items-center gap-1.5">
            <DayLink date={addDays(date, -1)} label="← Previous" />
            <DayLink date={localDateOf(new Date())} label="Today" />
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

      {day.away.length > 0 && (
        <p
          className="mb-4 rounded-[var(--radius)] border px-3 py-2 text-[13px]"
          style={{ borderColor: 'var(--warning)', background: 'var(--warning-soft)' }}
        >
          <span aria-hidden>⚠ </span>
          Away today:{' '}
          {day.away
            .map((id) => `${day.clinicians.find((c) => c.id === id)?.name ?? 'A clinician'} (${day.awayReasons[id]})`)
            .join(', ')}
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
                  className="absolute right-2 -translate-y-1/2 font-mono text-[11px] text-subtle"
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
      className="rounded-[var(--radius)] border px-2.5 py-1 text-[12.5px] transition-colors hover:bg-[var(--surface-inset)]"
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
  return (
    <div className="min-w-[150px] flex-1 border-r last:border-r-0" style={{ borderColor: 'var(--border)' }}>
      <div
        className="flex h-9 flex-col justify-center border-b px-2"
        style={{
          borderColor: 'var(--border)',
          background: accent ? 'var(--accent-soft)' : 'var(--surface-sunken)',
        }}
      >
        <span className="text-[12.5px] font-semibold leading-tight">{title}</span>
        <span className="text-[10.5px] leading-tight text-subtle">{subtitle}</span>
      </div>
      <div className="relative" style={{ height: (hours[hours.length - 1]! - hours[0]!) * PX_PER_MIN + 60 }}>
        {hours.map((m) => (
          <div
            key={m}
            className="absolute inset-x-0 border-t"
            style={{ top: (m - hours[0]!) * PX_PER_MIN, borderColor: 'var(--border)', opacity: 0.55 }}
          />
        ))}
        {sessions.map((s) => (
          <SessionChip key={s.id} session={s} top={(s.startMinute - hours[0]!) * PX_PER_MIN} />
        ))}
      </div>
    </div>
  );
}

function SessionChip({ session, top }: { session: DaySession; top: number }) {
  const meta = STATUS_META[session.status]!;
  const cancelled = session.status === 'cancelled' || session.status === 'late_cancelled';
  return (
    <Link
      href={`/appointments/${session.id}`}
      className="absolute inset-x-1 block overflow-hidden rounded-[var(--radius)] border px-1.5 py-1 text-[11.5px] transition-shadow hover:shadow-[var(--shadow)]"
      style={{
        top,
        height: (session.endMinute - session.startMinute) * PX_PER_MIN - 3,
        borderColor: `var(--status-${session.status.replace('_', '-')})`,
        // Cancelled sessions stay visible but recede — the hour is free, and the
        // record of who was meant to be in it still matters.
        background: cancelled ? 'var(--surface-sunken)' : 'var(--surface-raised)',
        borderLeftWidth: 3,
        opacity: cancelled ? 0.72 : 1,
      }}
    >
      <div className="flex items-center gap-1 font-medium">
        <span aria-hidden style={{ color: `var(--status-${session.status.replace('_', '-')})` }}>{meta.glyph}</span>
        <span className="truncate" style={{ textDecoration: cancelled ? 'line-through' : undefined }}>
          {session.client.lastName}
        </span>
      </div>
      <div className="truncate text-[10.5px] text-subtle">
        {minutesToHHMM(session.startMinute)} · {session.clinician.name.split(' ')[0]}
        {session.seriesId ? (session.detached ? ' · moved' : ' · standing') : ''}
      </div>
    </Link>
  );
}
