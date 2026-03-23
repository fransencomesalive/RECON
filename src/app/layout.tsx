import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import "mapbox-gl/dist/mapbox-gl.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000'
  ),
  title: 'R.E.C.O.N.',
  description: 'Route Environment & Condition Observation for Navigation — pre-ride intelligence for cyclists.',
  icons: {
    icon: '/RECON-1x1-favicon.png',
  },
  openGraph: {
    type:      'website',
    siteName:  'R.E.C.O.N.',
    title:     'R.E.C.O.N.',
    description: 'Pre-ride intelligence for cyclists. Upload a GPX or TCX route and get a full dossier: terrain, weather, land, coverage, and more.',
    images:    ['/RECON-shareimage-v2.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}
