import { prisma } from '../../../src/db';
import { UI, type Language } from '../../../src/strings';
import { Shell } from '../shell';

export const dynamic = 'force-dynamic';

export const metadata = { title: UI.en.enquireTitle };

/**
 * The one screen every submission reaches.
 *
 * A real enquiry, a fourth enquiry from somebody who already sent three, and a
 * robot caught by the honeypot all land here and read the same words. That is
 * the point: a page that varied would be a way to ask the practice questions
 * about itself — whether the form is watched, whether this person is already
 * known, whether the bot was spotted.
 */
export default async function EnquireDonePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams;
  const language: Language = q.lang === 'es' ? 'es' : 'en';
  const ui = UI[language];

  const settings = await prisma.practiceSettings.findUnique({
    where: { id: 1 },
    select: { messagingName: true, practicePhone: true },
  });

  return (
    <Shell practice={settings?.messagingName ?? 'Stillwater'} language={language}>
      <h1 className="text-xl font-semibold">{ui.enquireDoneHeading}</h1>
      <p className="mt-3 text-subhead leading-relaxed text-muted">{ui.enquireDoneBody}</p>
      {settings?.practicePhone && (
        <p className="mt-6 text-body leading-relaxed text-muted">{ui.enquireUrgent(settings.practicePhone)}</p>
      )}
    </Shell>
  );
}
