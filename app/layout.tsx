import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'drawn · UAV AI Design Intelligence',
  description:
    'AircraftVerse 기반 UAV 성능 예측, 설계 비교 및 AI 최적화 플랫폼',
  openGraph: {
    title: 'drawn · UAV AI Design Intelligence',
    description:
      'UAV 설계 입력부터 성능 시뮬레이션, A/B 비교, 목적 기반 최적화까지.',
    type: 'website',
    images: [
      {
        url: '/og.png?v=drawn',
        width: 1536,
        height: 1024,
        alt: 'drawn UAV AI Design Intelligence',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'drawn · UAV AI Design Intelligence',
    description:
      'AircraftVerse 기반 UAV 성능 예측·설계 비교·AI 최적화 플랫폼',
    images: ['/og.png?v=drawn'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
