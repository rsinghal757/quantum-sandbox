import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Quantum Sandbox Jobs',
  description: 'Monitor Quantum Sandbox MCP simulation jobs',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
