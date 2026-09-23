// Allowlist, not denylist: a host nobody thought to list (Render, Railway, a raw
// IP) must not slip through. Loopback or a unix socket passes; anything else needs
// CLEARPATH_ALLOW_CLOUD_DB, which is typed deliberately by db:migrate:prod etc.
export function isLocalDatabaseUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // Empty host = libpq unix-socket form (postgres:///db?host=/tmp).
  return host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
