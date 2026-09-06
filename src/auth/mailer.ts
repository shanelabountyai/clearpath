import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResetMailer } from './recovery';

/**
 * The driver that carries a reset link, and the one this repository ships.
 *
 * Same shape as `simulatedCarrier`, and here for the same reason: nothing in
 * this project sends. What matters is that the seam is a real interface with a
 * real driver behind it, so writing a second one against `ResetMailer` changes
 * no policy code at all — and so the flow above can be tested end to end
 * without a mail account.
 *
 * It writes to the filesystem rather than to the database, which is the whole
 * point of it existing at all. `OutboxMessage` stores `body`; a link written
 * there would be a live credential sitting in a table that the report, the
 * work lists and the delivery job all read. A file under a gitignored
 * directory is not *secure* — it is a development artefact, and it says so —
 * but it keeps a credential out of the one place this codebase has spent five
 * phases keeping credentials out of.
 */

/** Where the dev driver leaves its mail. Gitignored; see `.gitignore`. */
export const DEV_MAIL_DIR = '.dev-mail';

/** The driver itself. Selecting it is `configuredMailer`'s job, below. */
export function devMailer(dir = DEV_MAIL_DIR): ResetMailer {
  return {
    async send(to, link) {
      mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}-${to.email.replace(/[^a-z0-9]+/gi, '_')}.txt`;
      // The address, the name and the link. No password, no session token, and
      // no sentence about the person — this is a file on a disk, and the same
      // rule applies to it as to every other operational surface.
      writeFileSync(join(dir, name), `to: ${to.email}\nname: ${to.name}\nlink: ${link}\n`, 'utf8');
    },
  };
}

/**
 * Which driver the application uses, and the refusal when nobody has said.
 *
 * Deliberately an explicit opt-in rather than a `NODE_ENV` check. The first
 * draft keyed it on `NODE_ENV !== 'production'`, and the e2e sweep found the
 * hole immediately: that suite runs a production build on purpose, so the guard
 * fired on the one build that most needed exercising — and the fix that first
 * suggests itself, weakening the check, would leave a real deployment one
 * unset variable away from a reset flow that appears to work while every link
 * lands in a directory nobody reads. The first anybody would hear of it is a
 * clinician who cannot get back in.
 *
 * Naming the driver makes the statement the right way round: a deployment with
 * no mail provider fails at the moment somebody asks for a link, saying what is
 * missing, rather than succeeding quietly.
 */
export function configuredMailer(): ResetMailer {
  if (process.env.RESET_MAILER === 'dev') return devMailer();
  throw new Error(
    'No ResetMailer is configured. Set RESET_MAILER=dev to write links to '
    + `${DEV_MAIL_DIR}/, or implement ResetMailer against a real mail provider.`,
  );
}

/**
 * The most recent link written for an address, for the e2e suite and for a
 * person poking at the demo.
 *
 * Reads the directory rather than keeping state in memory, because the sweep
 * runs against a built server in a different process from the specs — the
 * filesystem is the only channel the two share, and that is a fair model of a
 * mailbox.
 */
export function latestResetLink(email: string, dir = DEV_MAIL_DIR): string | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort().reverse();
  } catch {
    return null;
  }
  for (const f of files) {
    const body = readFileSync(join(dir, f), 'utf8');
    if (body.includes(`to: ${email}\n`)) return body.match(/^link: (.+)$/m)?.[1] ?? null;
  }
  return null;
}
