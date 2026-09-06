import { openPortal } from '../../../src/portal/service';
import { prisma } from '../../../src/db';
import { Conflict, NotFound } from '../../../src/errors';
import { minutesToHHMM, utcToZoned } from '../../../src/time';
import { PORTAL_COPY, type PortalCopy } from '../../../src/portal/copy';
import { LANGUAGES, WEEKDAY_NAMES } from '../../../src/messaging/language';
import { money } from '../../../src/ui/primitives';
import { askToReschedule, chooseHowMany, sayNo, sayYes } from './actions';
import { CADENCES } from '../../../src/scheduling/confirmation';

export const dynamic = 'force-dynamic';

// The tab title says nothing. This page is opened on a shared phone.
export const metadata = { title: 'Your appointments' };

/** The same four codes the decline uses. Their wording lives in `copy.ts`. */
const REASON_CODES = ['cannot_make_it', 'need_a_different_time', 'prefer_earlier', 'prefer_later'] as const;

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
    // A token that resolves to nobody resolves to no language either, so the
    // refusal is bilingual rather than guessing. It is the one screen where
    // saying it twice is right: whoever is holding a dead link is exactly the
    // person this page knows least about.
    return (
      <Shell practice={practice} copy={PORTAL_COPY.en}>
        {LANGUAGES.map((language) => {
          const c = PORTAL_COPY[language];
          return (
            <div key={language} className="mb-6 last:mb-0">
              <h1 className="text-xl font-semibold">
                {e instanceof NotFound ? c.invalidLink : c.expiredLink}
              </h1>
              <p className="mt-2 text-subhead text-muted">{c.linkHelp}</p>
            </div>
          );
        })}
      </Shell>
    );
  }

  const copy = PORTAL_COPY[view.language];
  const weekdays = WEEKDAY_NAMES[view.language];

  return (
    <Shell practice={practice} copy={copy}>
      <h1 className="text-xl font-semibold">{copy.greeting(view.firstName)}</h1>
      <p className="mt-2 text-subhead text-muted">{copy.intro}</p>

      {q.asked && <Notice>{copy.askedNotice}</Notice>}
      {q.confirmed && <Notice>{copy.confirmedNotice}</Notice>}
      {q.declined && <Notice>{copy.declinedNotice}</Notice>}
      {q.cadence && <Notice>{copy.cadenceSaved}</Notice>}

      <hr className="my-6" style={{ borderColor: 'var(--border)' }} />

      {view.appointments.length === 0 ? (
        <p className="text-subhead text-muted">{copy.nothingBooked}</p>
      ) : (
        <ul className="space-y-5">
          {view.appointments.map((a) => {
            const when = utcToZoned(a.startAt);
            const pending = a.rescheduleRequests.length > 0;
            return (
              <li key={a.id} className="border-t pt-4 first:border-t-0 first:pt-0" style={{ borderColor: 'var(--border)' }}>
                <p className="text-subhead font-medium">
                  {weekdays[when.weekday]} {when.date}, {minutesToHHMM(when.minutes)}
                </p>
                <p className="mt-1 text-body text-muted">
                  {copy.with(a.clinician.name)}
                  {a.modality === 'telehealth' ? ` · ${copy.byVideo}` : a.room ? ` · ${a.room.name}` : ''}
                </p>

                {/*
                  The required response, and the whole of it: two buttons and no
                  box to type in. Only shown where the practice actually asked —
                  a client on `none` never sees a question they were never sent.
                */}
                {a.confirmation === 'confirmed' && (
                  <p className="mt-3 text-body text-subtle">{copy.alreadyConfirmed}</p>
                )}

                {a.confirmation === 'pending' && q.fee === a.id && (
                  <div
                    className="mt-3 rounded-[var(--radius)] border px-3 py-3"
                    style={{ borderColor: 'var(--danger)' }}
                  >
                    <p className="text-body">{copy.feeWarning(windowHours, lateFee)}</p>
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
                          {copy.feeConfirmButton}
                        </button>
                      </form>
                      <a href={`/p/${token}`} className="text-body underline">{copy.feeKeepLink}</a>
                    </div>
                  </div>
                )}

                {a.confirmation === 'pending' && q.fee !== a.id && (
                  /*
                   * Two rows, not one, and the screenshot pass is what
                   * settled it. Side by side, the decline's reason picker sat
                   * between the two buttons and read as belonging to neither
                   * — and directly above the reschedule request's picker, in
                   * the same words, so the page appeared to ask the same
                   * question twice with no way to tell which answer went
                   * where. On its own row the select is unambiguously the
                   * decline's, and confirming stays the single unobstructed
                   * tap it is supposed to be.
                   */
                  <div className="mt-3 space-y-2">
                    <form action={sayYes}>
                      <input type="hidden" name="token" value={token} />
                      <input type="hidden" name="appointmentId" value={a.id} />
                      <button
                        className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                        style={{ background: 'var(--accent)', color: 'var(--accent-contrast)', borderColor: 'var(--accent)' }}
                      >
                        {copy.confirmButton}
                      </button>
                    </form>
                    {/* P1-5. The same four codes as the reschedule request —
                        one question, one vocabulary, and still no box to type
                        in. It defaults to the plainest of them, so declining
                        stays one tap for a client who does not want to say. */}
                    <form action={sayNo} className="flex flex-wrap items-center gap-2 pt-1">
                      <input type="hidden" name="token" value={token} />
                      <input type="hidden" name="appointmentId" value={a.id} />
                      <label className="sr-only" htmlFor={`decline-reason-${a.id}`}>{copy.reasonLabel}</label>
                      <select
                        id={`decline-reason-${a.id}`}
                        name="reason"
                        className="rounded-[var(--radius)] border px-2 py-1.5 text-body"
                        style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                      >
                        {REASON_CODES.map((r) => <option key={r} value={r}>{copy.reasons[r]}</option>)}
                      </select>
                      <button
                        className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                        style={{ borderColor: 'var(--border-strong)' }}
                      >
                        {copy.declineButton}
                      </button>
                    </form>
                  </div>
                )}

                {pending ? (
                  <p className="mt-3 text-body text-subtle">{copy.changePending}</p>
                ) : (
                  <>
                  {/*
                   * Said out loud, because the two controls beneath an
                   * appointment look alike and do opposite things: one
                   * cancels the hour, possibly with a fee attached, and one
                   * only asks. Identical reason pickers stacked with nothing
                   * between them is how a client cancels a session they meant
                   * to move — the screenshot pass is where that became
                   * obvious.
                   */}
                  {a.confirmation === 'pending' && q.fee !== a.id && (
                    <p className="mt-4 text-caption text-subtle">{copy.rescheduleLead}</p>
                  )}
                  <form action={askToReschedule} className="mt-2 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="token" value={token} />
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <label className="sr-only" htmlFor={`reason-${a.id}`}>{copy.reasonLabel}</label>
                    <select
                      id={`reason-${a.id}`}
                      name="reason"
                      className="rounded-[var(--radius)] border px-2 py-1.5 text-body"
                      style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                    >
                      {REASON_CODES.map((r) => <option key={r} value={r}>{copy.reasons[r]}</option>)}
                    </select>
                    <button
                      className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                      style={{ borderColor: 'var(--border-strong)' }}
                    >
                      {copy.askToChange}
                    </button>
                  </form>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {/*
        The one control here that changes something about the client rather than
        about an appointment, and it is at the bottom because it is the least
        urgent thing on the page. It may narrow how many reminders they get and
        it may not reach the channel: a forwarded link leaving somebody on one
        message instead of three is strictly less harmful than one cancelling
        their session, which this door already does — but a link that could set
        "no messages" would silence them and end the fee together, so nothing
        would notice. The copy says where that request goes instead.
      */}
      <section className="mt-10 border-t pt-6" style={{ borderColor: 'var(--border)' }}>
        <h2 className="text-subhead font-medium">{copy.cadenceHeading}</h2>
        <form action={chooseHowMany} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="token" value={token} />
          <label className="sr-only" htmlFor="reminderCadence">{copy.cadenceHeading}</label>
          <select
            id="reminderCadence" name="reminderCadence"
            defaultValue={view.reminderCadence}
            className="rounded-[var(--radius)] border px-2 py-1.5 text-body"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
          >
            {CADENCES.map((c) => <option key={c} value={c}>{copy.cadences[c]}</option>)}
          </select>
          <button
            className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
            style={{ borderColor: 'var(--border-strong)' }}
          >
            {copy.cadenceSave}
          </button>
        </form>
        <p className="mt-2 max-w-prose text-caption text-subtle">{copy.cadenceHelp}</p>
      </section>
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

function Shell({ practice, copy, children }: { practice: string; copy: PortalCopy; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <p className="mb-6 text-body tracking-wide text-subtle uppercase">{practice}</p>
      {children}
      <footer className="mt-12 border-t pt-4 text-caption text-subtle" style={{ borderColor: 'var(--border)' }}>
        {copy.footer}
      </footer>
    </main>
  );
}
