import type { ReactNode } from "react";

export const metadata = {
  title: "PorterDirect",
  description: "White-label logistics platform for courier and freight operators.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
