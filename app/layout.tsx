import type { Metadata } from "next";
import type { ReactNode } from "react";
import { assertDeploymentReadiness } from "@/lib/deployment-boundary";

export const metadata: Metadata = {
  title: "Notion Research Agent",
  description:
    "Research the web with Gemini and send structured results to Notion.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  assertDeploymentReadiness();

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#fafafa" }}>{children}</body>
    </html>
  );
}
