import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

import { NETWORK } from "@/lib/near";

/// One family everywhere. Inter's tabular figures are what make a column of
/// prices line up, and `cv05`/`ss01` give the single-storey l and a that keep
/// an address like 0x1a1l readable.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/**
 * Where the app is served from, for absolute URLs in the share tags.
 *
 * Set explicitly rather than inferred, because Vercel's `VERCEL_URL` is the
 * deployment's own hostname - a different, uglier URL on every push - and a
 * share card that points at a preview deployment is worse than one with no
 * URL in it at all.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://wincut.vercel.app";

const TITLE = "WinCut — the trading app that only earns when you do";
const DESCRIPTION =
  "Copy trading on NEAR where the platform, the trader you copied and your referrer are paid " +
  "only out of your profit. Losing exits cost nothing and bank a credit against your next win.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    // Page titles read "The Cut Field · WinCut" rather than repeating the pitch.
    template: "%s · WinCut",
  },
  description: DESCRIPTION,
  applicationName: "WinCut",
  keywords: ["NEAR", "copy trading", "DeFi", "Rhea Finance", "no-loss fees"],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "WinCut",
    url: SITE_URL,
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  // Nothing here is a product listing and the testnet build is a demo, so
  // neither wants to be indexed as though it were a live venue.
  robots: NETWORK === "mainnet" ? { index: true, follow: true } : { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0B0E11",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
