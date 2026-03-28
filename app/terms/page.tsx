import type { Metadata } from "next";
import LegalDocument from "@/app/components/LegalDocument";

export const metadata: Metadata = {
  title: "Terms of Use | Notion MCP Backlog Desk",
  description: "Terms of use for the Notion MCP Backlog Desk integration and web application.",
};

const sections = [
  {
    title: "Acceptance of terms",
    body: [
      "By accessing or using Notion MCP Backlog Desk, you agree to these terms and to use the service only in a lawful manner and within the permissions granted by your Notion workspace and any connected providers.",
    ],
  },
  {
    title: "Permitted use",
    body: [
      "The service is intended for reviewed research, queue operations, and approved write-back into Notion. You are responsible for the prompts, source material, and content you choose to research, review, approve, and write.",
      "You must not use the service to violate law, misuse another party's data, interfere with the service, or bypass the product's review and access controls.",
    ],
  },
  {
    title: "Accounts, tokens, and integrations",
    body: [
      "You are responsible for safeguarding any access tokens, OAuth credentials, and linked Notion workspaces associated with your deployment. Actions taken through an approved connection are treated as authorized by the operator controlling that deployment.",
      "You must ensure the connected Notion integration has the right permissions for the pages and databases you choose to use.",
    ],
  },
  {
    title: "Service availability",
    body: [
      "The service is provided on an as-is and as-available basis. Features may depend on third-party APIs, model providers, browser tooling, search providers, hosting platforms, and Notion itself.",
      "The repository explicitly expects a long-lived Node host with writable persisted state for full durable-job behavior. Running it on unsupported infrastructure may reduce reliability or feature completeness.",
    ],
  },
  {
    title: "Responsibility for outputs",
    body: [
      "Research packets, generated drafts, and write payloads may be incomplete or incorrect. You are responsible for reviewing outputs before approving write-back into Notion or relying on them operationally.",
    ],
  },
  {
    title: "Limitation of liability",
    body: [
      "To the maximum extent permitted by law, the service operator is not liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for loss of data, profits, goodwill, or business interruption arising from use of the service.",
    ],
  },
  {
    title: "Changes",
    body: [
      "These terms may be updated from time to time. Continued use of the service after an update means the revised terms apply from the effective date shown on this page.",
    ],
  },
] as const;

export default function TermsPage() {
  return (
    <LegalDocument
      eyebrow="Legal"
      title="Terms of Use"
      summary="These terms govern use of the Notion MCP Backlog Desk app, connected workspaces, and reviewed write-back workflow."
      effectiveDate="March 27, 2026"
      sections={sections}
    />
  );
}