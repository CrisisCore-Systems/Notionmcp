import assert from "node:assert/strict";
import test from "node:test";
import { parseResearchResponseWithReconciliation } from "@/lib/agent";

test("parseResearchResponseWithReconciliation repairs malformed model JSON once before returning", async () => {
  const updates: string[] = [];
  const repairPrompts: string[] = [];

  const result = await parseResearchResponseWithReconciliation('```json\n{"suggestedDbTitle":"Broken"\n```', {
    onUpdate: (message) => {
      updates.push(message);
    },
    reconcile: async (repairPrompt) => {
      repairPrompts.push(repairPrompt);
      return JSON.stringify({
        suggestedDbTitle: "Recovered research",
        summary: "Recovered after one malformed model response.",
        schema: {
          Name: "title",
          URL: "url",
          Description: "rich_text",
        },
        items: [
          {
            Name: "Recovered row",
            URL: "https://example.com/recovered",
            Description: "Recovered description",
            __provenance: {
              sourceUrls: ["https://example.com/recovered"],
              evidenceByField: {
                Name: ["Recovered row"],
                Description: ["Recovered description"],
              },
            },
          },
        ],
      });
    },
  });

  assert.equal(repairPrompts.length, 1);
  assert.equal(result.suggestedDbTitle, "Recovered research");
  assert.equal(result.items.length, 1);
  assert.match(repairPrompts[0] ?? "", /Repair it into a single valid JSON object only/);
  assert.ok(
    updates.some((message) => message.includes("Reconciling extracted rows before approval"))
  );
  assert.ok(
    updates.some((message) => message.includes("Structured 1 row from 1 unique source after 1 reconciliation attempt"))
  );
});
