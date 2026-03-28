import type { Metadata } from "next";
import LegalDocument from "@/app/components/LegalDocument";

export const metadata: Metadata = {
  title: "Privacy Policy | Notion MCP Backlog Desk",
  description: "Privacy policy for the Notion MCP Backlog Desk integration and web application.",
};

const sections = [
  {
    title: "What this app processes",
    body: [
      "Notion MCP Backlog Desk processes the Notion workspace content, prompts, approved write payloads, and connection metadata needed to run the reviewed research and write-back workflow.",
      "If you connect a Notion workspace through OAuth, the app stores the resulting connection record and access token in encrypted persisted state so it can list databases, restore queue bindings, and execute the actions you approve.",
    ],
  },
  {
    title: "How information is used",
    body: [
      "Data is used only to operate the product features you invoke: queue discovery, research runs, human review, approved write-back, audit generation, and connection restoration.",
      "The app does not use your Notion content to train public models, sell your data, or repurpose workspace content for unrelated marketing activity.",
    ],
  },
  {
    title: "What is stored",
    body: [
      "The service may persist job state, write-audit artifacts, queue bindings, encrypted connection records, and limited operational metrics so runs can reconnect and completed writes remain traceable.",
      "Browser-side draft persistence is optional, remains off by default, and is stored only on the browser you explicitly enable it on.",
    ],
  },
  {
    title: "Sharing and disclosure",
    body: [
      "Workspace data is disclosed only to the infrastructure and model providers required to fulfill the request path you trigger, such as the configured LLM, search providers, browser automation, hosting, and Notion APIs.",
      "No personal information is sold. Data may be disclosed when required to comply with law, protect the service, or investigate abuse of the system.",
    ],
  },
  {
    title: "Security and retention",
    body: [
      "The app is designed for tightly controlled operator use. Sensitive persisted state is intended to be encrypted at rest in remote mode, and access to remote API routes is gated by origin and access-token checks.",
      "Retention depends on the host configuration chosen by the operator. Connection records, queue bindings, jobs, and write audits may be removed according to configured retention windows or when the operator deletes them.",
    ],
  },
  {
    title: "Your choices",
    body: [
      "You can disconnect a linked Notion workspace, clear browser drafts from the trusted browser where they were stored, and stop using the service at any time.",
      "If you need data removed from an operator-controlled deployment, contact the operator of that deployment because they control the hosted environment and persisted state.",
    ],
  },
] as const;

export default function PrivacyPage() {
  return (
    <LegalDocument
      eyebrow="Legal"
      title="Privacy Policy"
      summary="This policy explains what Notion MCP Backlog Desk processes, why it is processed, and what remains under operator control."
      effectiveDate="March 27, 2026"
      sections={sections}
    />
  );
}