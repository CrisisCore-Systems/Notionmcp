import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Instrument_Sans, Space_Grotesk } from "next/font/google";
import "./globals.css";

const bodyFont = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-body",
});

const displayFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "Notion MCP Backlog Desk",
  description:
    "Queue-first durable research and reviewed write-back for a Notion backlog.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${bodyFont.variable} ${displayFont.variable} app-body`}>{children}</body>
    </html>
  );
}
