import { prisma } from '../../../../src/db';
import { UI, type Language } from '../../../../src/strings';

export const dynamic = 'force-dynamic';
export const metadata = { title: UI.en.doneTitle };

export default async function DonePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const practice = await prisma.practiceSettings.findUnique({ where: { id: 1 }, select: { messagingName: true } });

  /**
   * The token is spent by the time anyone lands here — `openForm` refuses a
   * submitted request — so the language is read from the row directly. English
   * is the fallback for a token that has since been deleted, which is a page
   * saying "thank you" to nobody in particular.
   */
  const request = await prisma.formRequest.findUnique({
    where: { token },
    select: { client: { select: { language: true } } },
  });
  const language: Language = request?.client.language ?? 'en';
  const ui = UI[language];

  return (
    <main lang={language} className="mx-auto max-w-2xl px-5 py-16">
      <p className="mb-6 text-body tracking-wide text-subtle uppercase">{practice?.messagingName ?? 'Stillwater'}</p>
      <h1 className="text-xl font-semibold">{ui.doneHeading}</h1>
      <p className="mt-2 text-subhead leading-relaxed text-muted">{ui.doneBody}</p>
      <p className="mt-6 text-body text-subtle">{ui.doneClose}</p>
    </main>
  );
}
