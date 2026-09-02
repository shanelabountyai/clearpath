import { prisma } from '../../../../src/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sent' };

export default async function DonePage() {
  const practice = await prisma.practiceSettings.findUnique({ where: { id: 1 }, select: { messagingName: true } });
  return (
    <main className="mx-auto max-w-2xl px-5 py-16">
      <p className="mb-6 text-body tracking-wide text-subtle uppercase">{practice?.messagingName ?? 'Stillwater'}</p>
      <h1 className="text-xl font-semibold">Thank you — that has been sent.</h1>
      <p className="mt-2 text-subhead leading-relaxed text-muted">
        Your answers have gone to your clinician and they will have read them before you next
        meet. There is nothing else you need to do.
      </p>
      <p className="mt-6 text-body text-subtle">
        You can close this page. The link will not open again.
      </p>
    </main>
  );
}
