import { openForm } from '../../../src/forms/service';
import { prisma } from '../../../src/db';
import { Conflict, NotFound } from '../../../src/errors';
import { FormRunner } from './FormRunner';

export const dynamic = 'force-dynamic';

// The tab title says nothing. This page is opened on a shared phone.
export const metadata = { title: 'A form to complete' };

export default async function ClientFormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const practice = await prisma.practiceSettings.findUnique({ where: { id: 1 }, select: { messagingName: true } });

  let form;
  try {
    form = await openForm(token);
  } catch (e) {
    return (
      <Shell practice={practice?.messagingName ?? 'Stillwater'}>
        <h1 className="text-xl font-semibold">
          {e instanceof Conflict && e.code === 'already_submitted'
            ? 'This form has already been sent'
            : e instanceof NotFound
              ? 'This link is not valid'
              : 'This link has expired'}
        </h1>
        <p className="mt-2 text-subhead text-muted">
          If you think you still need to complete something, reply to the message you
          received and someone will send a new link.
        </p>
      </Shell>
    );
  }

  return (
    <Shell practice={practice?.messagingName ?? 'Stillwater'}>
      <h1 className="text-xl font-semibold">{form.name}</h1>
      {form.schema.intro && <p className="mt-2 text-subhead leading-relaxed text-muted">{form.schema.intro}</p>}
      <p className="mt-3 text-body text-subtle">
        Your answers go to your clinician. You can stop partway and come back using the same
        link.
      </p>
      <hr className="my-6" style={{ borderColor: 'var(--border)' }} />
      <FormRunner token={token} schema={form.schema} initialAnswers={form.answers} />
    </Shell>
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
