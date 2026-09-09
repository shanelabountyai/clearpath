import type { ReactNode } from 'react';
import { prisma } from '../../src/db';
import { UI, type Language } from '../../src/strings';
import { enquire } from './actions';
import { Shell } from './shell';

export const dynamic = 'force-dynamic';

/**
 * The public enquiry form (P2).
 *
 * The only page in Clearpath a stranger reaches, and the only one that writes
 * without a session or a token. Everything that bounds it lives in
 * `src/clients/public-inquiry.ts`; what this file is responsible for is the two
 * things a page can get wrong on its own — offering somewhere to write a
 * clinical sentence, and being written in a language its reader does not have.
 *
 * There is no box to type in. Not a small one, not one labelled "anything else
 * we should know". A counselling practice's public form is the single most
 * likely place in this application for somebody to disclose why they are
 * calling, and the field they would disclose it into is the one the PRD already
 * calls the honest weak point at the front-desk tier — where at least a person
 * hears it and types "prefers mornings". Here that filter does not exist. So
 * the form asks for a name and a way to reach them, says plainly that it is not
 * the place for anything else, and leaves the asking to somebody on a phone.
 */
export const metadata = { title: UI.en.enquireTitle };

export default async function EnquirePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams;
  const language: Language = q.lang === 'es' ? 'es' : 'en';
  const ui = UI[language];

  const settings = await prisma.practiceSettings.findUnique({
    where: { id: 1 },
    select: { messagingName: true, practicePhone: true, publicInquiryEnabled: true },
  });
  const practice = settings?.messagingName ?? 'Stillwater';
  const phone = settings?.practicePhone ?? '';

  // Names the practice publishes on its own website anyway, so offering the
  // list discloses nothing. Only people who see clients: front desk and the
  // practice manager are not appointments somebody asks for by name.
  const clinicians = await prisma.user.findMany({
    where: { active: true, role: { in: ['therapist', 'associate', 'supervisor'] } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const refusal = q.e && q.e in ui.enquireErrors
    ? ui.enquireErrors[q.e as keyof typeof ui.enquireErrors]
    : undefined;

  // The kill switch, drawn rather than 404'd: somebody who followed a link from
  // the practice's website needs the phone number, not a dead page.
  if (!settings?.publicInquiryEnabled) {
    return (
      <Shell practice={practice} language={language}>
        <h1 className="text-xl font-semibold">{ui.enquireHeading}</h1>
        <p className="mt-3 text-subhead text-muted">{ui.enquireErrors.closed}</p>
        {phone && <p className="mt-4 text-subhead">{ui.enquireUrgent(phone)}</p>}
      </Shell>
    );
  }

  return (
    <Shell practice={practice} language={language}>
      <h1 className="text-xl font-semibold">{ui.enquireHeading}</h1>
      <p className="mt-2 text-subhead leading-relaxed text-muted">{ui.enquireIntro}</p>

      {/*
        Above the fields, not below them and not in a footnote. It is the only
        instruction on the page that changes what somebody types.
      */}
      <p
        className="mt-4 rounded-[var(--radius)] border px-3 py-3 text-body leading-relaxed"
        style={{ borderColor: 'var(--border)' }}
      >
        {ui.enquireNoDetail}
      </p>

      {refusal && (
        <p
          className="mt-4 rounded-[var(--radius)] border px-3 py-3 text-body"
          style={{ borderColor: 'var(--danger)' }}
          role="alert"
        >
          {refusal}
        </p>
      )}

      <form action={enquire} className="mt-6 grid gap-4">
        <input type="hidden" name="lang" value={language} />

        {/*
          The honeypot. Hidden from anybody reading the page and from anybody
          hearing it, out of the tab order, and named nothing a browser autofills
          — a real submitter can neither see it nor be talked into filling it,
          so anything in it came from something that read the HTML.
        */}
        <div className="hidden" aria-hidden="true">
          <label htmlFor="website">Website</label>
          <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="firstName" label={ui.enquireFirstName}>
            <Input id="firstName" name="firstName" autoComplete="given-name" maxLength={80} required />
          </Field>
          <Field id="lastName" label={ui.enquireLastName}>
            <Input id="lastName" name="lastName" autoComplete="family-name" maxLength={80} required />
          </Field>
        </div>

        {/*
          `type="email"` and `required` do the ordinary catching in the browser,
          so a mistyped address is a red outline rather than a round trip that
          spends one of this submitter's three attempts for the hour. The server
          re-checks all of it regardless — a form control is a convenience, and
          this endpoint is reachable without one.
        */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="email" label={ui.enquireEmail}>
            <Input id="email" name="email" type="email" autoComplete="email" maxLength={160} />
          </Field>
          <Field id="phone" label={ui.enquirePhone}>
            <Input id="phone" name="phone" type="tel" autoComplete="tel" maxLength={40} />
          </Field>
        </div>
        <p className="-mt-2 text-caption text-subtle">{ui.enquireContactHint}</p>

        <Field id="requestedClinicianId" label={ui.enquireClinician}>
          <Select id="requestedClinicianId" name="requestedClinicianId" defaultValue="">
            <option value="">{ui.enquireNoPreference}</option>
            {clinicians.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>

        <Field id="referralSource" label={ui.enquireHeardHow}>
          <Select id="referralSource" name="referralSource" defaultValue="other" required>
            {(Object.keys(ui.enquireSources) as (keyof typeof ui.enquireSources)[]).map((k) => (
              <option key={k} value={k}>{ui.enquireSources[k]}</option>
            ))}
          </Select>
        </Field>

        <div>
          <button
            className="rounded-[var(--radius)] border px-4 py-2 text-body font-medium"
            style={{ background: 'var(--accent)', color: 'var(--on-solid)', borderColor: 'var(--accent)' }}
          >
            {ui.enquireSubmit}
          </button>
        </div>
      </form>

      {phone && (
        <p className="mt-8 text-body leading-relaxed text-muted">{ui.enquireUrgent(phone)}</p>
      )}
    </Shell>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-body font-medium">{label}</label>
      {children}
    </div>
  );
}

const CONTROL =
  'rounded-[var(--radius)] border px-3 py-2 text-body';

const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={CONTROL} style={{ borderColor: 'var(--border)' }} />
);

const Select = (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={CONTROL} style={{ borderColor: 'var(--border)' }} />
);
