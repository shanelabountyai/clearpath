import { openPortal } from '../../../src/portal/service';
import { prisma } from '../../../src/db';
import { Conflict, NotFound } from '../../../src/errors';
import { minutesToHHMM, utcToZoned, WEEKDAYS } from '../../../src/time';
import { money } from '../../../src/ui/primitives';
import { askToReschedule, sayNo, sayYes } from './actions';

export const dynamic = 'force-dynamic';

// The tab title says nothing. This page is opened on a shared phone.
export const metadata = { title: 'Your appointments' };

const REASONS: { value: string; label: string }[] = [
  { value: 'cannot_make_it', label: 'I cannot make this time' },
  { value: 'need_a_different_time', label: 'I need a different time' },
  { value: 'prefer_earlier', label: 'I would prefer something earlier' },
  { value: 'prefer_later', label: 'I would prefer something later' },
];

export default async function ClientPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { token } = await params;
  const q = await searchParams;
  const settings = await prisma.practiceSettings.findUnique({
    where: { id: 1 },
    select: { messagingName: true, lateCancelWindowHours: true, lateCancelFeeCents: true },
  });
  const practice = settings?.messagingName ?? 'Stillwater';
  const windowHours = settings?.lateCancelWindowHours ?? 24;
  const lateFee = money(settings?.lateCancelFeeCents ?? 9000);

  let view;
  try {
    view = await openPortal(token);
  } catch (e) {
    return (
      <Shell practice={practice}>
        <h1 className="text-xl font-semibold">
          {e instanceof NotFound ? 'This link is not valid' : 'This link has expired'}
        </h1>
        <p className="mt-2 text-subhead text-muted">
          Reply to the message you received and someone will send you a new one.
        </p>
        {e instanceof Conflict ? null : null}
      </Shell>
    );
  }

  return (
    <Shell practice={practice}>
      <h1 className="text-xl font-semibold">Hello {view.firstName}</h1>
      <p className="mt-2 text-subhead text-muted">
        Your upcoming appointments. To change one, choose a reason and someone will
        call you — nothing moves until you have spoken to them.
      </p>

      {q.asked && <Notice>Thank you — someone will be in touch about that appointment.</Notice>}
      {q.confirmed && <Notice>Thank you — we have you down for that one.</Notice>}
      {q.declined && <Notice>That is cancelled. Reply to the message you received to rebook.</Notice>}

      <hr className="my-6" style={{ borderColor: 'var(--border)' }} />

      {view.appointments.length === 0 ? (
        <p className="text-subhead text-muted">
          You have nothing booked at the moment. Reply to the message you received to
          arrange something.
        </p>
      ) : (
        <ul className="space-y-5">
          {view.appointments.map((a) => {
            const when = utcToZoned(a.startAt);
            const pending = a.rescheduleRequests.length > 0;
            return (
              <li key={a.id} className="border-t pt-4 first:border-t-0 first:pt-0" style={{ borderColor: 'var(--border)' }}>
                <p className="text-subhead font-medium">
                  {WEEKDAYS[when.weekday]} {when.date}, {minutesToHHMM(when.minutes)}
                </p>
                <p className="mt-1 text-body text-muted">
                  With {a.clinician.name}
                  {a.modality === 'telehealth' ? ' · by video' : a.room ? ` · ${a.room.name}` : ''}
                </p>

                {/*
                  The required response, and the whole of it: two buttons and no
                  box to type in. Only shown where the practice actually asked —
                  a client on `none` never sees a question they were never sent.
                */}
                {a.confirmation === 'confirmed' && (
                  <p className="mt-3 text-body text-subtle">You have confirmed this one.</p>
                )}

                {a.confirmation === 'pending' && q.fee === a.id && (
                  <div
                    className="mt-3 rounded-[var(--radius)] border px-3 py-3"
                    style={{ borderColor: 'var(--danger)' }}
                  >
                    <p className="text-body">
                      Cancelling within {windowHours} hours of the appointment is
                      charged at {lateFee}. Do you still want to cancel it?
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <form action={sayNo}>
                        <input type="hidden" name="token" value={token} />
                        <input type="hidden" name="appointmentId" value={a.id} />
                        <input type="hidden" name="acknowledgeFee" value="1" />
                        {/* Carried through the interstitial rather than asked
                            again: the client answered this before they were
                            shown the fee, and the fee is not a new question. */}
                        <input type="hidden" name="reason" value={q.reason ?? 'cannot_make_it'} />
                        <button
                          className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                          style={{ background: 'var(--danger)', color: 'var(--on-solid)', borderColor: 'var(--danger)' }}
                        >
                          Yes, cancel it
                        </button>
                      </form>
                      <a href={`/p/${token}`} className="text-body underline">Keep the appointment</a>
                    </div>
                  </div>
                )}

                {a.confirmation === 'pending' && q.fee !== a.id && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <form action={sayYes}>
                      <input type="hidden" name="token" value={token} />
                      <input type="hidden" name="appointmentId" value={a.id} />
                      <button
                        className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                        style={{ background: 'var(--accent)', color: 'var(--accent-contrast)', borderColor: 'var(--accent)' }}
                      >
                        Yes, I will be there
                      </button>
                    </form>
                    {/* P1-5. The same four codes as the reschedule request —
                        one question, one vocabulary, and still no box to type
                        in. It defaults to the plainest of them, so declining
                        stays one tap for a client who does not want to say. */}
                    <form action={sayNo} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="token" value={token} />
                      <input type="hidden" name="appointmentId" value={a.id} />
                      <label className="sr-only" htmlFor={`decline-reason-${a.id}`}>Reason</label>
                      <select
                        id={`decline-reason-${a.id}`}
                        name="reason"
                        className="rounded-[var(--radius)] border px-2 py-1.5 text-body"
                        style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                      >
                        {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                      <button
                        className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                        style={{ borderColor: 'var(--border-strong)' }}
                      >
                        I cannot make it
                      </button>
                    </form>
                  </div>
                )}

                {pending ? (
                  <p className="mt-3 text-body text-subtle">
                    You have asked to change this one. Someone will call you.
                  </p>
                ) : (
                  <form action={askToReschedule} className="mt-3 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="token" value={token} />
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <label className="sr-only" htmlFor={`reason-${a.id}`}>Reason</label>
                    <select
                      id={`reason-${a.id}`}
                      name="reason"
                      className="rounded-[var(--radius)] border px-2 py-1.5 text-body"
                      style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                    >
                      {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    <button
                      className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                      style={{ borderColor: 'var(--border-strong)' }}
                    >
                      Ask to change this
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Shell>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mt-4 rounded-[var(--radius)] border px-3 py-2 text-body"
      style={{ borderColor: 'var(--border-strong)' }}
    >
      {children}
    </p>
  );
}

function Shell({ practice, children }: { practice: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <p className="mb-6 text-body tracking-wide text-subtle uppercase">{practice}</p>
      {children}
      <footer className="mt-12 border-t pt-4 text-caption text-subtle" style={{ borderColor: 'var(--border)' }}>
        This link is personal to you. Please do not forward it.
      </footer>
    </main>
  );
}
