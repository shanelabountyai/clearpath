import { openForm } from '../../../src/forms/service';
import { inLanguage } from '../../../src/forms/schema';
import { prisma } from '../../../src/db';
import { Conflict, NotFound } from '../../../src/errors';
import { LANGUAGES, UI, type Language } from '../../../src/strings';
import { FormRunner } from './FormRunner';

export const dynamic = 'force-dynamic';

// The tab title says nothing. This page is opened on a shared phone, and it is
// English because a tab title is rendered before the token resolves anybody.
export const metadata = { title: UI.en.formTitle };

export default async function ClientFormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const practice = await prisma.practiceSettings.findUnique({ where: { id: 1 }, select: { messagingName: true } });
  const practiceName = practice?.messagingName ?? 'Stillwater';

  let form;
  try {
    form = await openForm(token);
  } catch (e) {
    const kind =
      e instanceof Conflict && e.code === 'already_submitted' ? 'sent'
        : e instanceof NotFound ? 'invalid'
          : 'expired';
    return <BrokenLink practice={practiceName} kind={kind} />;
  }

  const language = form.language;
  const ui = UI[language];

  return (
    <Shell practice={practiceName} language={language}>
      <h1 className="text-xl font-semibold">{form.schema.title ? inLanguage(form.schema.title, language) : form.name}</h1>
      {form.schema.intro && (
        <p className="mt-2 text-subhead leading-relaxed text-muted">{inLanguage(form.schema.intro, language)}</p>
      )}
      <p className="mt-3 text-body text-subtle">{ui.formIntro}</p>
      <hr className="my-6" style={{ borderColor: 'var(--border)' }} />
      <FormRunner token={token} language={language} schema={form.schema} initialAnswers={form.answers} />
    </Shell>
  );
}

/**
 * Written in every language, because a dead token resolves nobody to ask.
 * See the same function in the appointments portal — this is the one screen
 * whose reader is unknown, and the client least able to act on an English
 * apology is exactly the one it would otherwise land on.
 */
function BrokenLink({ practice, kind }: { practice: string; kind: 'sent' | 'invalid' | 'expired' }) {
  return (
    <Shell practice={practice} language="en">
      {LANGUAGES.map((l, i) => (
        <div key={l} className={i > 0 ? 'mt-8' : undefined} lang={l}>
          <h1 className="text-xl font-semibold">
            {kind === 'sent' ? UI[l].formAlreadySent : kind === 'invalid' ? UI[l].linkInvalid : UI[l].linkExpired}
          </h1>
          <p className="mt-2 text-subhead text-muted">{UI[l].formLinkHelp}</p>
        </div>
      ))}
    </Shell>
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
