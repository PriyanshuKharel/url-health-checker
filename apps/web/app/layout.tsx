import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bulk URL Health Checker',
  description: 'Submit a list of URLs and watch their health checks complete in real time.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            Bulk URL Health Checker
          </Link>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
