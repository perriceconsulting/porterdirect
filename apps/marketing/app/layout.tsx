import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

/**
 * The public origin, taken from the ONE variable that already means that
 * (`BETTER_AUTH_URL` — "public origin this instance is served on"). Introducing a second
 * env var for the same fact is how two answers to "what is this site's URL" appear, and
 * they drift the first time a domain changes.
 *
 * `metadataBase` is not optional here: without it Next cannot turn the relative
 * opengraph-image path into the absolute URL that crawlers require, so the card renders
 * with no image and nothing warns loudly.
 */
const siteUrl = process.env.BETTER_AUTH_URL ?? "https://porterdirect.com";

const TITLE = "PorterDirect — white-label logistics platform";
const DESCRIPTION =
  "Dispatch, live tracking and proof of delivery, running under your brand and on your " +
  "domain. Flat monthly pricing, zero per-delivery commission.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "PorterDirect",
  // A shared link shows image + title + description. The MARK cannot explain a business
  // model — these two lines are what tell an operator this is software they run, not a
  // courier competing with them. `app/opengraph-image.png` is picked up by filename.
  openGraph: {
    type: "website",
    siteName: "PorterDirect",
    title: TITLE,
    description: DESCRIPTION,
    url: siteUrl,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Google Fonts is the one font host allowed by our CSP; every face still
            declares a real fallback stack in globals.css so a blocked request
            degrades rather than silently swapping to a default. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
