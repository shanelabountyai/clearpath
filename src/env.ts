import { z } from 'zod';

/**
 * Every environment variable the running application reads, checked once at
 * boot (`instrumentation.ts`).
 *
 * The failure this exists to stop is the quiet one. A variable that is absent,
 * or present but pasted with a trailing newline, lets the server start
 * perfectly happily and then surfaces hours later as a 401 nobody can explain
 * (`safeEqual` is length-checked, so one invisible character is a permanent
 * mismatch) or a client-facing link that resolves to nothing. Named at
 * startup, it is a thirty-second fix.
 *
 * It deliberately does NOT replace the lazy production throws in `clientUrl`,
 * `throttleSecret` and `signBreakGlass`. Those three variables are optional
 * locally and required in production, and "is this production" is not
 * decidable here: `db:seed:prod` is a plain local `tsx` run whose NODE_ENV is
 * nothing at all. Their check stays at the point of use, where the whole
 * condition is known. This schema only rejects values that are wrong in every
 * environment.
 *
 * Out of scope on purpose: CI, SHOTS, E2E_DEV, PGDATABASE, DS_COMPONENTS_OUT.
 * Those are read by the test harness and the design-system script, never by
 * the app, and a schema that claims them would be asserting something about a
 * process this never runs in. `env.test.ts` greps for the boundary.
 */

/**
 * Blank means unset. Every consumer in this codebase tests truthiness
 * (`if (env.CRON_SECRET)`), and a `.env` copied from `.env.example` seeds
 * exactly these empty strings — so a blank must pass as "not set", not fail as
 * "malformed".
 */
const blankAsUnset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** Surrounding whitespace is the one malformation a secret cannot survive. */
const secret = z.preprocess(
  blankAsUnset,
  z.string().refine((v) => v === v.trim(), 'has leading or trailing whitespace').optional(),
);

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, 'must start with postgres:// or postgresql://')
  .refine((v) => URL.canParse(v), 'is not a parseable URL');

export const envSchema = z.object({
  // The only variable with no fallback anywhere: src/db.ts throws on it too,
  // but by then a request is already in flight.
  DATABASE_URL: postgresUrl,
  // Migrations only (prisma.config.ts); absent outside `prisma migrate dev`.
  SHADOW_DATABASE_URL: z.preprocess(blankAsUnset, postgresUrl.optional()),
  // Presence is the whole signal — the value is never inspected.
  CLEARPATH_ALLOW_CLOUD_DB: z.string().optional(),

  DEMO_ACCESS_PASSWORD: secret,
  CLEARPATH_SESSION_SECRET: secret,
  CLEARPATH_THROTTLE_SECRET: secret,
  CRON_SECRET: secret,

  // Accepts a bare host as well as a full URL, because `clientUrl` does — it
  // prefixes a missing scheme rather than shipping a relative link in an SMS.
  // Validated through that same normalisation so the two cannot disagree.
  CLEARPATH_BASE_URL: z.preprocess(
    blankAsUnset,
    z
      .string()
      .refine(
        (v) => URL.canParse(/^https?:\/\//.test(v.trim()) ? v.trim() : `https://${v.trim()}`),
        'is not a host or an http(s) URL',
      )
      .optional(),
  ),
  // Set by the platform, not by us.
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),

  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  PORT: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(65535).optional()),
});

export type Env = z.infer<typeof envSchema>;

/** The variables this schema owns, for the coverage grep in `env.test.ts`. */
export const ENV_VARS = Object.keys(envSchema.shape) as (keyof Env)[];

/**
 * Throws naming every bad variable at once, not just the first — a deployment
 * missing three variables should take one restart to fix, not three.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = String(issue.path[0] ?? '(environment)');
    const raw = source[name];
    // zod's "expected string, received undefined" is true but unhelpful, and
    // a blank is read as unset everywhere else, so it reports as unset here.
    return raw === undefined || raw.trim() === ''
      ? `${name} is not set`
      : `${name} ${issue.message}`;
  });

  throw new Error(`Environment is not valid:\n  ${[...new Set(problems)].sort().join('\n  ')}`);
}
