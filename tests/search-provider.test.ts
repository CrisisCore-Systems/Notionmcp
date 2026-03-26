import assert from "node:assert/strict";
import test from "node:test";
import type { Browser } from "playwright";
import { browserTestOverrides, getConfiguredSearchProviders, searchWeb } from "@/lib/browser";

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
  assert.equal(providers.includes("unknown" as never), false);
});

test("duckduckgo fallback launches a fresh browser for each search and tolerates context shutdown crashes", async () => {
  const originalSearchProviders = process.env.SEARCH_PROVIDERS;
  const launchedBrowsers: number[] = [];
  const closedBrowsers: number[] = [];
  const closedContexts: number[] = [];
  let launchCount = 0;

  process.env.SEARCH_PROVIDERS = "duckduckgo";
  browserTestOverrides.setLaunchBrowser(async () => {
    const browserId = launchCount++;
    launchedBrowsers.push(browserId);

    const page = {
      goto: async () => ({ ok: () => true }),
      waitForLoadState: async () => undefined,
      evaluate: async () => [
        {
          title: `Result ${browserId + 1}`,
          url: `https://example.com/${browserId + 1}`,
          snippet: `Snippet ${browserId + 1}`,
        },
      ],
    };
    const context = {
      route: async () => undefined,
      newPage: async () => page,
      close: async () => {
        closedContexts.push(browserId);

        if (browserId === 0) {
          throw new Error("page crashed during cleanup");
        }
      },
    };

    return {
      isConnected: () => true,
      newContext: async () => context,
      close: async () => {
        closedBrowsers.push(browserId);
      },
    } as unknown as Browser;
  });

  try {
    const firstResults = await searchWeb("first query");
    const secondResults = await searchWeb("second query");

    assert.deepEqual(firstResults.map((result) => result.url), ["https://example.com/1"]);
    assert.deepEqual(secondResults.map((result) => result.url), ["https://example.com/2"]);
    assert.deepEqual(launchedBrowsers, [0, 1]);
    assert.deepEqual(closedContexts, [0, 1]);
    assert.deepEqual(closedBrowsers, [0, 1]);
  } finally {
    browserTestOverrides.reset();
    process.env.SEARCH_PROVIDERS = originalSearchProviders;
  }
});
