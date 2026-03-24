import assert from "node:assert/strict";
import test from "node:test";
import { getValidationIssues } from "@/app/components/chat/chat-utils";

test("getValidationIssues blocks approval for weak provenance coverage", () => {
  const issues = getValidationIssues({
    suggestedDbTitle: "Research",
    summary: "Summary",
    schema: {
      Name: "title",
      Description: "rich_text",
      URL: "url",
    },
    items: [
      {
        Name: "Alpha",
        Description: "Alpha summary",
        URL: "https://example.com",
        __provenance: {
          sourceUrls: ["https://example.com"],
          evidenceByField: {
            Description: ["Only the description is evidenced"],
          },
        },
      },
    ],
  });

  assert.equal(issues.length >= 1, true);
  assert.match(issues.map((issue) => issue.message).join("\n"), /evidence for every populated field/);
});

test("getValidationIssues accepts rows with complete provenance coverage", () => {
  const issues = getValidationIssues({
    suggestedDbTitle: "Research",
    summary: "Summary",
    schema: {
      Name: "title",
      Description: "rich_text",
      URL: "url",
    },
    items: [
      {
        Name: "Alpha",
        Description: "Alpha summary",
        URL: "https://example.com",
        __provenance: {
          sourceUrls: ["https://example.com"],
          evidenceByField: {
            Name: ["Alpha is named on the page"],
            Description: ["Alpha summary appears in the overview section"],
          },
        },
      },
    ],
  });

  assert.deepEqual(issues, []);
});
