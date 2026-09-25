/**
 * Boot-time environment check (K11). `register` runs once per server instance
 * and must finish before the first request, so a misconfigured deployment
 * fails here, naming the variable, rather than mid-request.
 *
 * Node runtime only. The edge runtime — where proxy.ts runs — gets its own
 * `register` call, but its `process.env` holds only what was inlined at build
 * time, so validating DATABASE_URL there would fail a deployment that is in
 * fact configured correctly. The dynamic import keeps zod and the schema out
 * of the edge bundle entirely (verified: zod appears only in the node chunk,
 * not in middleware.js).
 *
 * A failed check does not exit the process — Next catches it, logs
 * "An error occurred while loading instrumentation hook" with the variable
 * name, and answers 500 to every route including /api/cron/*. That is the
 * behaviour we want: nothing is served, nothing is quietly public, and the
 * cause is in the first line of the log.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { parseEnv } = await import('./src/env');
  parseEnv();
}
