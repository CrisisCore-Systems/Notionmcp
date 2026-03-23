import { chromium, Browser, type Page } from "playwright";

let browser: Browser | null = null;
const MAX_SEARCH_RESULTS = 6;
const MAX_EXTRACTED_CHARACTERS = 8000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

type SearchAdapter = {
  name: "serper" | "duckduckgo";
  search: (query: string) => Promise<SearchResult[]>;
};

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function waitForSettledPage(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: 3000 });
  } catch {
    // Some pages never fully settle. Continue with the best available DOM.
  }
}

function normalizeSearchResults(results: SearchResult[]): SearchResult[] {
  const seenUrls = new Set<string>();

  const isSearchResultUrl = (value: string): boolean => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  };

  return results
    .map((result) => ({
      title: result.title.trim(),
      url: result.url.trim(),
      snippet: result.snippet.trim(),
    }))
    .filter((result) => {
      if (!result.title || !isSearchResultUrl(result.url) || seenUrls.has(result.url)) {
        return false;
      }

      seenUrls.add(result.url);
      return true;
    })
    .slice(0, MAX_SEARCH_RESULTS);
}

async function searchWithSerper(query: string): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("SERPER_API_KEY is not configured.");
  }

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ q: query, num: MAX_SEARCH_RESULTS }),
  });

  if (!response.ok) {
    throw new Error(`Serper search failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };

  return normalizeSearchResults(
    (payload.organic ?? []).map((result) => ({
      title: result.title ?? "",
      url: result.link ?? "",
      snippet: result.snippet ?? "",
    }))
  );
}

async function searchWithDuckDuckGo(query: string): Promise<SearchResult[]> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await waitForSettledPage(page);

    const results = await page.evaluate((maxResults) => {
      const rows = Array.from(
        document.querySelectorAll(".result, .web-result, .results_links, .result__body")
      );

      return rows.slice(0, maxResults).map((row) => {
        const link = row.querySelector("a.result__a, .result__title a, a[data-testid='result-title-a']");
        const snippet =
          row.querySelector(".result__snippet, .result-snippet, .result__extras__url")?.textContent ??
          "";

        return {
          title: link?.textContent?.trim() ?? "",
          url: (link as HTMLAnchorElement | null)?.href ?? "",
          snippet: snippet.trim(),
        };
      });
    }, MAX_SEARCH_RESULTS * 2);

    return normalizeSearchResults(results);
  } finally {
    await page.close();
  }
}

function getSearchAdapter(): SearchAdapter {
  if (process.env.SERPER_API_KEY?.trim()) {
    return { name: "serper", search: searchWithSerper };
  }

  return { name: "duckduckgo", search: searchWithDuckDuckGo };
}

/** Navigate to a URL and extract readable text content */
export async function browseAndExtract(url: string): Promise<string> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForSettledPage(page);

    const content = await page.evaluate((maxCharacters) => {
      const root =
        document.querySelector("main, article, [role='main'], .main, #main") ??
        document.body;
      const container = root.cloneNode(true) as HTMLElement;

      container
        .querySelectorAll(
          "script,style,noscript,iframe,svg,canvas,form,button,input,select,textarea,.cookie,.popup,.modal,.ad,.advertisement,[aria-hidden='true']"
        )
        .forEach((el) => el.remove());

      const lines: string[] = [];
      let currentLength = 0;
      const pushLine = (value?: string | null) => {
        const nextValue = value?.replace(/\s+/g, " ").trim();

        if (!nextValue || lines.includes(nextValue)) {
          return;
        }

        lines.push(nextValue);
        currentLength += nextValue.length + 1;
      };

      pushLine(document.title);
      pushLine(document.querySelector("meta[name='description']")?.getAttribute("content"));

      const textNodes = Array.from(
        container.querySelectorAll("h1, h2, h3, p, li, blockquote, pre")
      )
        .map((element) => element.textContent)
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim())
        .filter(Boolean);

      for (const value of textNodes) {
        pushLine(value);
        if (currentLength >= maxCharacters) {
          break;
        }
      }

      const tableRows = Array.from(container.querySelectorAll("table"))
        .slice(0, 3)
        .flatMap((table) =>
          Array.from(table.querySelectorAll("tr")).map((row) =>
            Array.from(row.querySelectorAll("th, td"))
              .map((cell) => cell.textContent?.replace(/\s+/g, " ").trim() ?? "")
              .filter(Boolean)
              .join(" | ")
          )
        )
        .filter(Boolean);

      for (const row of tableRows) {
        pushLine(row);
        if (currentLength >= maxCharacters) {
          break;
        }
      }

      const notableLinks = Array.from(container.querySelectorAll("a[href]"))
        .slice(0, 8)
        .map((link) => {
          const label = link.textContent?.replace(/\s+/g, " ").trim() ?? "";
          const href = link.getAttribute("href") ?? "";

          if (!label || !href) {
            return "";
          }

          try {
            const absoluteUrl = new URL(href, document.baseURI).toString();
            return `${label}: ${absoluteUrl}`;
          } catch {
            return "";
          }
        })
        .filter(Boolean);

      for (const link of notableLinks) {
        pushLine(link);
        if (currentLength >= maxCharacters) {
          break;
        }
      }

      return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxCharacters);
    }, MAX_EXTRACTED_CHARACTERS);

    return content || "No content extracted.";
  } catch (err) {
    return `Error browsing ${url}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await page.close();
  }
}

/** Search the configured provider and return top result URLs + snippets */
export async function searchWeb(
  query: string
): Promise<SearchResult[]> {
  const adapter = getSearchAdapter();

  try {
    return await adapter.search(query);
  } catch (err) {
    if (adapter.name !== "duckduckgo") {
      try {
        return await searchWithDuckDuckGo(query);
      } catch {
        // Fall through to the standard error payload below.
      }
    }

    return [
      {
        title: `Search error (${adapter.name})`,
        url: "",
        snippet: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}
