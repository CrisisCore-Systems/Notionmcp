import assert from "node:assert/strict";
import test from "node:test";
import {
  isResearchResult,
  isValidDatabaseId,
  normalizeResearchResult,
  parseResearchResult,
} from "@/lib/write-payload";
import { buildDuplicateFingerprint } from "@/lib/notion-mcp";

test("normalizeResearchResult trims values and deduplicates schema names", () => {
  const result = normalizeResearchResult({
    suggestedDbTitle: "  Competitors  ",
    summary: "  Summary text  ",
    schema: {
      Name: "title",
      name: "rich_text",
      URL: "url",
      Score: "number",
    },
    items: [
      {
        Name: "  Alpha  ",
        name: true as unknown as string,
        URL: " https://example.com ",
        Score: "42",
        __provenance: {
          sourceUrls: ["https://example.com", "notaurl"],
          evidenceByField: {
            Name: ["  Alpha company  "],
            Empty: [""],
          },
        },
      },
    ],
  });

  assert.deepEqual(result.schema, {
    Name: "title",
    "name 2": "rich_text",
    URL: "url",
    Score: "number",
  });
  assert.deepEqual(result.items, [
    {
      Name: "Alpha",
      "name 2": "true",
      URL: "https://example.com",
      Score: "42",
      __provenance: {
        sourceUrls: ["https://example.com"],
        evidenceByField: {
          Name: ["Alpha company"],
        },
      },
    },
  ]);
});

test("normalizeResearchResult rejects invalid numeric values", () => {
  assert.throws(
    () =>
      normalizeResearchResult({
        suggestedDbTitle: "Scores",
        summary: "Summary",
        schema: {
          Name: "title",
          Score: "number",
        },
        items: [
          {
            Name: "Alpha",
            Score: "NaN-ish",
          },
        ],
      }),
    /non-numeric value/
  );
});

test("parseResearchResult rejects malformed payloads before the UI boundary", () => {
  assert.throws(
    () =>
      parseResearchResult(
        {
          suggestedDbTitle: "Broken",
          summary: "Summary",
          schema: { Name: "title" },
          items: ["not-an-object"],
        },
        "Agent returned an invalid research payload."
      ),
    /Agent returned an invalid research payload/
  );
});

test("isResearchResult rejects malformed payloads", () => {
  assert.equal(
    isResearchResult({
      suggestedDbTitle: "Test",
      summary: "Summary",
      schema: { Name: "title" },
      items: [],
    }),
    false
  );
});

test("isValidDatabaseId accepts only valid Notion database IDs", () => {
  assert.equal(isValidDatabaseId("1234"), false);
  assert.equal(isValidDatabaseId("1a2b3c4d5e6f77889900aabbccddeeff"), true);
});

test("buildDuplicateFingerprint uses stable title and URL identity", () => {
  const schema = {
    Name: "title",
    URL: "url",
    Summary: "rich_text",
  } as const;

  const first = buildDuplicateFingerprint(
    {
      Name: "Linear",
      URL: "https://example.com/company/",
      Summary: "Original summary",
    },
    schema
  );
  const second = buildDuplicateFingerprint(
    {
      Name: "  linear  ",
      URL: "https://example.com/company",
      Summary: "Different summary text",
    },
    schema
  );

  assert.equal(first, second);
});
