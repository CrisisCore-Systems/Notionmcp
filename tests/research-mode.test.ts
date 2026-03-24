import assert from "node:assert/strict";
import test from "node:test";
import { buildDeepResearchBrowseQueue, classifySourceClass, getResearchProfile } from "@/lib/agent";

test("getResearchProfile keeps the fast lane as default and exposes higher deep caps", () => {
  const fast = getResearchProfile();
  const deep = getResearchProfile("deep");

  assert.equal(fast.mode, "fast");
  assert.equal(fast.maxEvidenceDocuments, 8);
  assert.equal(deep.mode, "deep");
  assert.equal(deep.maxPlannedQueries, 6);
  assert.equal(deep.maxEvidenceDocuments, 12);
  assert.equal(deep.minUniqueDomains, 4);
  assert.equal(deep.minSourceClasses, 3);
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
