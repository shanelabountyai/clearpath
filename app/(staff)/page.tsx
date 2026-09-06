import { redirect } from 'next/navigation';
import { requireSession } from '../../src/session';
import { navFor } from '../../src/ui/shell';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const session = await requireSession();
  // Land everyone on the first thing their role can actually do.
  redirect(navFor(session.actor)[0]?.href ?? '/clients');
}
