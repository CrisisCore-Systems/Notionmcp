import assert from "node:assert/strict";
import test from "node:test";
import {
  isResearchResult,
  isValidDatabaseId,
  normalizeResearchResult,
} from "@/lib/write-payload";

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
