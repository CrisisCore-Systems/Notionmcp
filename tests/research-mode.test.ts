import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceDocument } from "@/lib/browser";
import {
  buildDeepResearchBrowseQueue,
  classifySourceClass,
  getResearchProfile,
  parseResearchMode,
  reviewEvidenceDocumentSource,
  validateResearchEvidenceCoverage,
} from "@/lib/agent";
import { assessCitationAgreement } from "@/lib/contradiction-check";
import {
  assessEvidenceDocumentQuality,
  scoreUrlSourceQuality,
  summarizeSourceQuality,
} from "@/lib/source-quality";

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
  assert.equal(fast.plannerModel, "gemini-2.0-flash");
  assert.equal(deep.verifierModel, "gemini-2.5-pro");
  assert.equal(deep.maxReconciliationAttempts, 3);
  assert.equal(deep.minIndependentSourcesPerField, 2);
  assert.equal(deep.minCrossSourceAgreement, 1);
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

test("scoreUrlSourceQuality ranks official and reference sources above community and other pages", () => {
  assert.ok(scoreUrlSourceQuality("https://docs.example.com/api") > scoreUrlSourceQuality("https://news.example.com/story"));
  assert.ok(
    scoreUrlSourceQuality("https://www.crunchbase.com/organization/example") >
      scoreUrlSourceQuality("https://github.com/example/project")
  );
  assert.ok(scoreUrlSourceQuality("https://github.com/example/project") > scoreUrlSourceQuality("https://random.example/x"));
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

test("buildDeepResearchBrowseQueue fills unused deep slots with higher-quality leftovers first", () => {
  const queue = buildDeepResearchBrowseQueue(
    [
      "https://github.com/example/project",
      "https://community.example.com/thread",
      "https://docs.example.com/guide",
      "https://support.example.com/pricing",
    ],
    {
      ...getResearchProfile("deep"),
      maxEvidenceDocuments: 3,
      minUniqueDomains: 1,
      minSourceClasses: 1,
    }
  );

  assert.deepEqual(queue, [
    "https://github.com/example/project",
    "https://docs.example.com/guide",
    "https://support.example.com/pricing",
  ]);
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

test("reviewEvidenceDocumentSource applies stricter source-quality checks in deep mode", () => {
  const document: EvidenceDocument = {
    finalUrl: "https://community.example.com/thread",
    title: "Operator notes",
    contentType: "text/html",
    sourceUrls: ["https://community.example.com/thread"],
    redirectChain: [],
    evidenceSnippets: ["Page title: Operator notes"],
    evidenceFields: [
      {
        label: "Page title",
        value: "Operator notes",
        source: "meta",
        kind: "title",
        certainty: "high",
        sourceUrl: "https://community.example.com/thread",
        id: "comm-f1",
        untrusted: true,
      },
      {
        label: "Meta description",
        value: "A summary of a user-reported workflow.",
        source: "meta",
        kind: "meta-description",
        certainty: "high",
        sourceUrl: "https://community.example.com/thread",
        id: "comm-f2",
        untrusted: true,
      },
      {
        label: "Heading",
        value: "Workflow summary",
        source: "text",
        kind: "heading",
        certainty: "medium",
        sourceUrl: "https://community.example.com/thread",
        id: "comm-f3",
        untrusted: true,
      },
    ],
    untrusted: true,
  };
  const sourceQuality = assessEvidenceDocumentQuality(document, "operator workflow notes");

  assert.deepEqual(reviewEvidenceDocumentSource(document, "fast", sourceQuality), {
    legitimate: true,
    reasons: [],
  });
  assert.deepEqual(reviewEvidenceDocumentSource(document, "deep", sourceQuality), {
    legitimate: false,
    reasons: ["low-source-quality"],
  });
});

test("assessCitationAgreement surfaces unresolved direct contradiction across sources", () => {
  assert.deepEqual(
    assessCitationAgreement("Pricing starts at $49 per seat.", [
      {
        sourceUrl: "https://docs.example.com/pricing",
        snippet: "Pricing starts at $49 per seat.",
      },
      {
        sourceUrl: "https://blog.example.com/pricing",
        snippet: "Pricing starts at $59 per seat.",
      },
    ]),
    {
      matchingSourceUrls: ["https://docs.example.com/pricing"],
      conflictingSourceUrls: ["https://blog.example.com/pricing"],
      agreementRatio: 0.5,
      unresolvedDirectContradiction: true,
    }
  );
});

test("summarizeSourceQuality reports primary and freshness coverage for deep mode", () => {
  const assessments = [
    assessEvidenceDocumentQuality(
      {
        finalUrl: "https://docs.example.com/pricing",
        title: "Pricing",
        contentType: "text/html",
        sourceUrls: ["https://docs.example.com/pricing"],
        redirectChain: [],
        evidenceSnippets: [],
        evidenceFields: [
          {
            id: "doc-f1",
            label: "Structured evidence",
            value: "datePublished: 2025-01-15",
            source: "schema",
            kind: "structured",
            certainty: "high",
            sourceUrl: "https://docs.example.com/pricing",
            untrusted: true,
          },
        ],
        untrusted: true,
      },
      "current pricing"
    ),
    assessEvidenceDocumentQuality(
      {
        finalUrl: "https://news.example.com/story",
        title: "Pricing analysis",
        contentType: "text/html",
        sourceUrls: ["https://news.example.com/story"],
        redirectChain: [],
        evidenceSnippets: [],
        evidenceFields: [
          {
            id: "news-f1",
            label: "Heading",
            value: "Pricing analysis",
            source: "text",
            kind: "heading",
            certainty: "medium",
            sourceUrl: "https://news.example.com/story",
            untrusted: true,
          },
        ],
        untrusted: true,
      },
      "current pricing"
    ),
  ];

  assert.deepEqual(summarizeSourceQuality(assessments), {
    averageScore: Number(((assessments[0].score + assessments[1].score) / 2).toFixed(1)),
    primarySourceCount: 1,
    officialSourceCount: 1,
    dateAvailableSourceCount: 1,
    authorAvailableSourceCount: 0,
    strongestSourceUrls: [
      assessments[0].url,
      assessments[1].url,
    ],
  });
});

test("validateResearchEvidenceCoverage requires an official or primary source in deep mode when relevant", () => {
  const evidenceDocuments: EvidenceDocument[] = [
    {
      finalUrl: "https://news.example.com/pricing",
      title: "Pricing report",
      contentType: "text/html",
      sourceUrls: ["https://news.example.com/pricing"],
      redirectChain: [],
      evidenceSnippets: [],
      evidenceFields: [
        {
          id: "news-f1",
          label: "Heading",
          value: "Pricing starts at $49 per seat.",
          source: "text",
          kind: "heading",
          certainty: "medium",
          sourceUrl: "https://news.example.com/pricing",
          untrusted: true,
        },
      ],
      untrusted: true,
    },
    {
      finalUrl: "https://www.crunchbase.com/organization/example",
      title: "Company record",
      contentType: "text/html",
      sourceUrls: ["https://www.crunchbase.com/organization/example"],
      redirectChain: [],
      evidenceSnippets: [],
      evidenceFields: [
        {
          id: "ref-f1",
          label: "Structured evidence",
          value: "Pricing starts at $49 per seat.",
          source: "schema",
          kind: "structured",
          certainty: "high",
          sourceUrl: "https://www.crunchbase.com/organization/example",
          untrusted: true,
        },
      ],
      untrusted: true,
    },
  ];
  const sourceQualityByUrl = new Map(
    evidenceDocuments.map((document) => [document.finalUrl, assessEvidenceDocumentQuality(document, "current api pricing")] as const)
  );

  assert.throws(
    () =>
      validateResearchEvidenceCoverage(
        {
          suggestedDbTitle: "Pricing",
          summary: "Summary",
          schema: {
            Name: "title",
            Description: "rich_text",
          },
          items: [
            {
              Name: "Example",
              Description: "Current API pricing starts at $49 per seat.",
              __provenance: {
                sourceUrls: [
                  "https://news.example.com/pricing",
                  "https://www.crunchbase.com/organization/example",
                ],
                evidenceByField: {
                  Name: ["[news-f1] Pricing starts at $49 per seat."],
                  Description: [
                    "[news-f1] Pricing starts at $49 per seat.",
                    "[ref-f1] Pricing starts at $49 per seat.",
                  ],
                },
              },
            },
          ],
        },
        evidenceDocuments,
        {
          mode: "deep",
          prompt: "current api pricing",
          sourceQualityByUrl,
          minIndependentSourcesPerField: 2,
          minCrossSourceAgreement: 1,
        }
      ),
    /official or primary source/i
  );
});

test("validateResearchEvidenceCoverage requires dated sources for time-sensitive deep-mode claims", () => {
  const evidenceDocuments: EvidenceDocument[] = [
    {
      finalUrl: "https://docs.example.com/pricing",
      title: "Pricing",
      contentType: "text/html",
      sourceUrls: ["https://docs.example.com/pricing"],
      redirectChain: [],
      evidenceSnippets: [],
      evidenceFields: [
        {
          id: "doc-f1",
          label: "Heading",
          value: "Pricing starts at $49 per seat.",
          source: "text",
          kind: "heading",
          certainty: "medium",
          sourceUrl: "https://docs.example.com/pricing",
          untrusted: true,
        },
      ],
      untrusted: true,
    },
    {
      finalUrl: "https://news.example.com/pricing",
      title: "Pricing report",
      contentType: "text/html",
      sourceUrls: ["https://news.example.com/pricing"],
      redirectChain: [],
      evidenceSnippets: [],
      evidenceFields: [
        {
          id: "news-f1",
          label: "Heading",
          value: "Pricing starts at $49 per seat.",
          source: "text",
          kind: "heading",
          certainty: "medium",
          sourceUrl: "https://news.example.com/pricing",
          untrusted: true,
        },
      ],
      untrusted: true,
    },
  ];
  const sourceQualityByUrl = new Map(
    evidenceDocuments.map((document) => [document.finalUrl, assessEvidenceDocumentQuality(document, "current pricing")] as const)
  );

  assert.throws(
    () =>
      validateResearchEvidenceCoverage(
        {
          suggestedDbTitle: "Pricing",
          summary: "Summary",
          schema: {
            Name: "title",
            Description: "rich_text",
          },
          items: [
            {
              Name: "Example",
              Description: "Current pricing starts at $49 per seat.",
              __provenance: {
                sourceUrls: ["https://docs.example.com/pricing", "https://news.example.com/pricing"],
                evidenceByField: {
                  Name: ["[doc-f1] Pricing starts at $49 per seat."],
                  Description: [
                    "[doc-f1] Pricing starts at $49 per seat.",
                    "[news-f1] Pricing starts at $49 per seat.",
                  ],
                },
              },
            },
          ],
        },
        evidenceDocuments,
        {
          mode: "deep",
          prompt: "current pricing",
          sourceQualityByUrl,
          minIndependentSourcesPerField: 2,
          minCrossSourceAgreement: 1,
        }
      ),
    /dated source/i
  );
});
