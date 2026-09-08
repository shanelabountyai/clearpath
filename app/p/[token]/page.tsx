import { openPortal, RESCHEDULE_REASONS } from '../../../src/portal/service';
import { prisma } from '../../../src/db';
import { NotFound } from '../../../src/errors';
import { LANGUAGES, moneyIn, UI, whenLong, type Language } from '../../../src/strings';
import { askToReschedule, sayNo, sayYes } from './actions';

export const dynamic = 'force-dynamic';

// The tab title says nothing. This page is opened on a shared phone, and it is
// English because a tab title is rendered before the token resolves anybody.
export const metadata = { title: UI.en.portalTitle };

/**
 * The order is the service's, the words are the dictionary's.
 *
 * The list is iterated straight off `RESCHEDULE_REASONS` rather than a copy
 * kept next to the translations, so `ui.reasons[r]` is what type-checks the
 * pair: a fifth reason added to the enum fails to compile here until both
 * languages answer for it. That is the nearest a page gets to the guarantee
 * `CLIENT_TEMPLATES` takes from `Record<Language, ...>`.
 */
/**
 * The same four codes wherever the client is asked, and still no text box.
 *
 * `blank` is what separates the two questions. A reschedule request is
 * meaningless without a reason — front desk would have nothing to act on — so
 * that one is required. A decline is complete on its own: the hour comes back
 * whether or not the client says why, and a required answer here would be a
 * toll on giving it back. Left blank, the column stays null, which reads the
 * same as the keyword decline that can never carry one.
 */
function ReasonSelect({ id, language, blank }: { id: string; language: Language; blank?: string }) {
  const ui = UI[language];
  return (
    <>
      <label className="sr-only" htmlFor={id}>{ui.reasonLabel}</label>
      <select
        id={id}
        name="reason"
        className="rounded-[var(--radius)] border px-2 py-1.5 text-body"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
      >
        {blank && <option value="">{blank}</option>}
        {RESCHEDULE_REASONS.map((r) => <option key={r} value={r}>{ui.reasons[r]}</option>)}
      </select>
    </>
  );
}

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
  const feeCents = settings?.lateCancelFeeCents ?? 9000;

  let view;
  try {
    view = await openPortal(token);
  } catch (e) {
    return <BrokenLink practice={practice} kind={e instanceof NotFound ? 'invalid' : 'expired'} />;
  }

  const language = view.language;
  const ui = UI[language];
  const lateFee = moneyIn(language, feeCents);

  return (
    <Shell practice={practice} language={language}>
      <h1 className="text-xl font-semibold">{ui.greeting(view.firstName)}</h1>
      <p className="mt-2 text-subhead text-muted">{ui.portalIntro}</p>

      {q.asked && <Notice>{ui.noticeAsked}</Notice>}
      {q.confirmed && <Notice>{ui.noticeConfirmed}</Notice>}
      {q.declined && <Notice>{ui.noticeDeclined}</Notice>}

      <hr className="my-6" style={{ borderColor: 'var(--border)' }} />

      {view.appointments.length === 0 ? (
        <p className="text-subhead text-muted">{ui.nothingBooked}</p>
      ) : (
        <ul className="space-y-5">
          {view.appointments.map((a) => {
            const pending = a.rescheduleRequests.length > 0;
            return (
              <li key={a.id} className="border-t pt-4 first:border-t-0 first:pt-0" style={{ borderColor: 'var(--border)' }}>
                <p className="text-subhead font-medium">{whenLong(language, a.startAt)}</p>
                <p className="mt-1 text-body text-muted">
                  {ui.withClinician(a.clinician.name)}
                  {a.modality === 'telehealth' ? ` · ${ui.byVideo}` : a.room ? ` · ${a.room.name}` : ''}
                </p>

                {/*
                  The required response, and the whole of it: two buttons and no
                  box to type in. Only shown where the practice actually asked —
                  a client on `none` never sees a question they were never sent.
                */}
                {a.confirmation === 'confirmed' && (
                  <p className="mt-3 text-body text-subtle">{ui.alreadyConfirmed}</p>
                )}

                {a.confirmation === 'pending' && q.fee === a.id && (
                  <div
                    className="mt-3 rounded-[var(--radius)] border px-3 py-3"
                    style={{ borderColor: 'var(--danger)' }}
                  >
                    {/*
                      The fee disclosure. The number comes from settings and the
                      sentence around it from the dictionary, so the amount and
                      the language it is explained in can never drift apart —
                      which is the whole reason this screen was translated first.
                    */}
                    <p className="text-body">{ui.feeWarning(windowHours, lateFee)}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <form action={sayNo} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="token" value={token} />
                        <input type="hidden" name="appointmentId" value={a.id} />
                        <input type="hidden" name="acknowledgeFee" value="1" />
                        <ReasonSelect id={`fee-why-${a.id}`} language={language} blank={ui.reasonBlank} />
                        <button
                          className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                          style={{ background: 'var(--danger)', color: 'var(--on-solid)', borderColor: 'var(--danger)' }}
                        >
                          {ui.cancelYes}
                        </button>
                      </form>
                      <a href={`/p/${token}`} className="text-body underline">{ui.cancelKeep}</a>
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
                        {ui.confirmYes}
                      </button>
                    </form>
                    <form action={sayNo} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="token" value={token} />
                      <input type="hidden" name="appointmentId" value={a.id} />
                      <ReasonSelect id={`why-${a.id}`} language={language} blank={ui.reasonBlank} />
                      <button
                        className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                        style={{ borderColor: 'var(--border-strong)' }}
                      >
                        {ui.confirmNo}
                      </button>
                    </form>
                  </div>
                )}

                {pending ? (
                  <p className="mt-3 text-body text-subtle">{ui.changePending}</p>
                ) : (
                  <form action={askToReschedule} className="mt-3 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="token" value={token} />
                    <input type="hidden" name="appointmentId" value={a.id} />
                    <ReasonSelect id={`reason-${a.id}`} language={language} />
                    <button
                      className="rounded-[var(--radius)] border px-3 py-1.5 text-body font-medium"
                      style={{ borderColor: 'var(--border-strong)' }}
                    >
                      {ui.changeAsk}
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

/**
 * The one page whose reader is unknown, so it is written in every language.
 *
 * A dead token resolves nobody — that is what makes it dead — so there is no
 * `Client.language` to read, and defaulting to English would put the practice's
 * least helpful screen in front of exactly the client least able to act on it.
 * Two short paragraphs is cheaper than the alternative, which is a query
 * against an expired token purely to learn what language to apologise in.
 */
function BrokenLink({ practice, kind }: { practice: string; kind: 'invalid' | 'expired' }) {
  return (
    <Shell practice={practice} language="en">
      {LANGUAGES.map((l, i) => (
        <div key={l} className={i > 0 ? 'mt-8' : undefined} lang={l}>
          <h1 className="text-xl font-semibold">
            {kind === 'invalid' ? UI[l].linkInvalid : UI[l].linkExpired}
          </h1>
          <p className="mt-2 text-subhead text-muted">{UI[l].linkHelp}</p>
        </div>
      ))}
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

function Shell({
  practice, language, children,
}: {
  practice: string; language: Language; children: React.ReactNode;
}) {
  return (
    <main lang={language} className="mx-auto max-w-2xl px-5 py-10">
      <p className="mb-6 text-body tracking-wide text-subtle uppercase">{practice}</p>
      {children}
      <footer className="mt-12 border-t pt-4 text-caption text-subtle" style={{ borderColor: 'var(--border)' }}>
        {UI[language].footer}
      </footer>
    </main>
  );
}
