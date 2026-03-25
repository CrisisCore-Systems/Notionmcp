import type { Metadata } from "next";
import type { ReactNode } from "react";
import { assertDeploymentReadiness } from "@/lib/deployment-boundary";

export const metadata: Metadata = {
  title: "Notion MCP Backlog Desk",
  description:
    "Pull ready Notion backlog items via MCP, research them, review the draft, and write the approved packet back to Notion.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  assertDeploymentReadiness();

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#fafafa" }}>{children}</body>
    </html>
  );
}
