import assert from "node:assert/strict";
import test from "node:test";
import { getConfiguredSearchProviders } from "@/lib/browser";

test("getConfiguredSearchProviders prefers configured API providers before browser fallback", () => {
  const providers = getConfiguredSearchProviders({
    ...process.env,
    SERPER_API_KEY: "serper-key",
    BRAVE_SEARCH_API_KEY: "brave-key",
  });

  assert.deepEqual(providers, ["serper", "brave", "duckduckgo"]);
});

test("getConfiguredSearchProviders accepts an explicit provider order", () => {
  const providers = getConfiguredSearchProviders({
    ...process.env,
    SEARCH_PROVIDERS: "brave,duckduckgo,serper,duckduckgo,unknown",
  });

  assert.deepEqual(providers, ["brave", "duckduckgo", "serper"]);
});
