import type { NextConfig } from 'next';

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
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      { source: '/f/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      { source: '/p/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ];
  },
};

export default config;
