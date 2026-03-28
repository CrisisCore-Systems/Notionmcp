import Link from "next/link";
import type { ReactNode } from "react";

type LegalSection = {
  readonly title: string;
  readonly body: readonly ReactNode[];
};

type LegalDocumentProps = {
  readonly eyebrow: string;
  readonly title: string;
  readonly summary: string;
  readonly effectiveDate: string;
  readonly sections: readonly LegalSection[];
};

export default function LegalDocument({
  eyebrow,
  title,
  summary,
  effectiveDate,
  sections,
}: LegalDocumentProps) {
  return (
    <main className="legal-root">
      <div className="legal-shell">
        <section className="legal-hero">
          <div className="legal-kicker">{eyebrow}</div>
          <h1 className="legal-title">{title}</h1>
          <p className="legal-summary">{summary}</p>
          <div className="legal-meta">
            <span>Effective {effectiveDate}</span>
            <Link href="/">Back to app</Link>
          </div>
        </section>

        <article className="legal-card">
          {sections.map((section) => (
            <section key={section.title} className="legal-section">
              <h2>{section.title}</h2>
              {section.body.map((paragraph, index) => (
                <p key={`${section.title}-${index}`}>{paragraph}</p>
              ))}
            </section>
          ))}
        </article>
      </div>
    </main>
  );
}