import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  // Deliberately says nothing about what the practice does or who is on screen.
  // A browser tab is a public surface: it shows up in screen shares, in
  // history, and on a laptop somebody else walks past.
  title: 'Clearpath',
  description: 'Practice operations',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
