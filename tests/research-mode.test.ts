import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeepResearchBrowseQueue,
  classifySourceClass,
  getResearchProfile,
  parseResearchMode,
  reviewEvidenceDocumentSource,
} from "@/lib/agent";

test("getResearchProfile keeps the fast lane as default and exposes higher deep caps", () => {
  const fast = getResearchProfile();
  const deep = getResearchProfile("deep");

  assert.equal(fast.mode, "fast");
  assert.equal(fast.minPlannedQueries, 1);
  assert.equal(fast.maxEvidenceDocuments, 8);
  assert.equal(deep.mode, "deep");
  assert.equal(deep.minPlannedQueries, 5);
  assert.equal(deep.maxPlannedQueries, 8);
  assert.equal(deep.maxBrowsePerQuery, 4);
  assert.equal(deep.maxEvidenceDocuments, 16);
  assert.equal(deep.minUniqueDomains, 5);
  assert.equal(deep.minSourceClasses, 4);
});

test("parseResearchMode keeps deliberate aliases explicit and rejects unknown lanes", () => {
  assert.equal(parseResearchMode(undefined), "fast");
  assert.equal(parseResearchMode("fast-lane"), "fast");
  assert.equal(parseResearchMode("deep-research"), "deep");
  assert.equal(parseResearchMode("max-depth"), null);
});

test("classifySourceClass groups urls into reviewed evidence buckets", () => {
  assert.equal(classifySourceClass("https://docs.example.com/api"), "official");
  assert.equal(classifySourceClass("https://news.example.com/story"), "editorial");
  assert.equal(classifySourceClass("https://github.com/example/project"), "community");
  assert.equal(classifySourceClass("https://www.crunchbase.com/organization/example"), "reference");
});

test("buildDeepResearchBrowseQueue prioritizes domain diversity and source classes", () => {
  const queue = buildDeepResearchBrowseQueue([
    "https://docs.alpha.com/guide",
    "https://docs.alpha.com/reference",
    "https://news.beta.com/story",
    "https://github.com/example/project",
    "https://www.crunchbase.com/organization/example",
    "https://community.gamma.com/thread",
    "https://www.g2.com/products/example/reviews",
  ]);

  const domains = new Set(queue.map((url) => new URL(url).hostname.replace(/^www\./, "")));
  const sourceClasses = new Set(queue.map((url) => classifySourceClass(url)));

  assert.ok(queue.length <= getResearchProfile("deep").maxEvidenceDocuments);
  assert.ok(domains.size >= 4);
  assert.ok(sourceClasses.size >= 3);
  assert.equal(queue.filter((url) => url.includes("alpha.com")).length <= 2, true);
});

test("reviewEvidenceDocumentSource requires corroborating extracted fields instead of trusting url shape", () => {
  assert.deepEqual(
    reviewEvidenceDocumentSource({
      finalUrl: "https://docs.example.com/api",
      title: "API Documentation",
      contentType: "text/html",
      sourceUrls: ["https://docs.example.com/api"],
      redirectChain: [],
      evidenceSnippets: ["Page title: API Documentation"],
      evidenceFields: [
        {
          label: "Page text",
          value: "Welcome to the docs.",
          source: "text",
          kind: "text-block",
          certainty: "low",
          sourceUrl: "https://docs.example.com/api",
          id: "doc-f1",
          untrusted: true,
        },
      ],
      untrusted: true,
    }),
    {
      legitimate: false,
      reasons: [
        "insufficient-field-corroboration",
        "page-text-only",
        "missing-structured-evidence",
        "missing-independent-corroboration",
      ],
    }
  );

  assert.deepEqual(
    reviewEvidenceDocumentSource({
      finalUrl: "https://docs.example.com/api",
      canonicalUrl: "https://docs.example.com/api",
      title: "API Documentation",
      contentType: "text/html",
      sourceUrls: ["https://docs.example.com/api"],
      redirectChain: [],
      evidenceSnippets: [
        "Page title: API Documentation",
        "Structured evidence: name: Example API",
      ],
      evidenceFields: [
        {
          label: "Page title",
          value: "API Documentation",
          source: "meta",
          kind: "title",
          certainty: "high",
          sourceUrl: "https://docs.example.com/api",
          id: "doc-f1",
          untrusted: true,
        },
        {
          label: "Structured evidence",
          value: "name: Example API",
          source: "schema",
          kind: "structured",
          certainty: "high",
          sourceUrl: "https://docs.example.com/api",
          id: "doc-f2",
          untrusted: true,
        },
        {
          label: "Heading",
          value: "Example API overview",
          source: "text",
          kind: "heading",
          certainty: "medium",
          sourceUrl: "https://docs.example.com/api",
          id: "doc-f3",
          untrusted: true,
        },
      ],
      untrusted: true,
    }),
    {
      legitimate: true,
      reasons: [],
    }
  );
});
