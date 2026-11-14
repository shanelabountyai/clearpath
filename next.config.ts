import type { NextConfig } from 'next';

/**
 * The capability-token doors (K6). The token is in the path, so the page must
 * not be cached or indexed.
 */
const TOKEN_DOOR_HEADERS = [
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

const config: NextConfig = {
  // The generated Prisma client and the pg driver stay on the server.
  serverExternalPackages: ['@prisma/client', 'pg'],
  typedRoutes: false,
  poweredByHeader: false,
  // Staff screens must not be framable (clickjacking); /f and /p carry capability
  // tokens in the path, so nothing may leak them via Referer or sit in a cache.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // same-origin, not no-referrer: no-referrer makes the browser send
          // `Origin: null` on a same-origin form POST, and Next then refuses the
          // Server Action, which breaks the no-JavaScript enquiry form.
          { key: 'Referrer-Policy', value: 'same-origin' },
          // Vercel adds HSTS on its own domains; set here so the app does not
          // depend on the host for it. Inert over http (localhost).
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
      // Listed after the global entry, so these win where a key repeats.
      // The form door submits from the browser (FormRunner), never as a native
      // form POST, so it can drop the Referer entirely.
      { source: '/f/:path*', headers: [...TOKEN_DOOR_HEADERS, { key: 'Referrer-Policy', value: 'no-referrer' }] },
      // The appointments door keeps same-origin: its Yes/No/reschedule buttons
      // are native form POSTs that must work without JavaScript, and under
      // no-referrer the browser sends `Origin: null`, which Next refuses as a
      // cross-site Server Action (checked 2026-11-13 on a production build).
      // same-origin already sends nothing to any other site.
      { source: '/p/:path*', headers: TOKEN_DOOR_HEADERS },
    ];
  },
};

export default config;
