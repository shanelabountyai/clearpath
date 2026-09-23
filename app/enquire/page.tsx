import { prisma } from '../../src/db';
import { UI, type Language } from '../../src/strings';
import { EnquireForm } from './enquire-form';
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
      <p
        role="note"
        className="mt-3 rounded-[var(--radius)] border px-3 py-3 text-body font-semibold leading-relaxed"
        style={{ borderColor: 'var(--border)' }}
      >
        {ui.enquireDemoNotice}
      </p>
      <p className="mt-3 text-subhead leading-relaxed text-muted">{ui.enquireIntro}</p>

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

      <EnquireForm language={language} clinicians={clinicians} />

      {phone && (
        <p className="mt-8 text-body leading-relaxed text-muted">{ui.enquireUrgent(phone)}</p>
      )}
    </Shell>
  );
}
