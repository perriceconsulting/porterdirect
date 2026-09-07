import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "PorterDirect — white-label logistics platform",
  description:
    "Dispatch, live tracking and proof of delivery, running under your brand and on your domain. Flat monthly pricing, zero per-delivery commission.",
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
