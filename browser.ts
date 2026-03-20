import { chromium, Browser } from "playwright";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

/** Navigate to a URL and extract readable text content */
export async function browseAndExtract(url: string): Promise<string> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    const content = await page.evaluate(() => {
      // Strip noise
      document
        .querySelectorAll(
          "script,style,nav,footer,header,aside,.nav,.footer,.header,.sidebar,.cookie,.popup,.modal,.ad,.advertisement,[aria-hidden='true']"
        )
        .forEach((el) => el.remove());

      // Prefer semantic main content
      const main =
        document.querySelector("main, article, [role='main'], .main, #main") ||
        document.body;

      return (main as HTMLElement).innerText
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 6000);
    });

    return content || "No content extracted.";
  } catch (err) {
    return `Error browsing ${url}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await page.close();
  }
}

/** Search Google and return top result URLs + snippets */
export async function searchWeb(
  query: string
): Promise<{ title: string; url: string; snippet: string }[]> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.goto(
      `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      { waitUntil: "domcontentloaded", timeout: 20000 }
    );

    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("div.g"))
        .slice(0, 6)
        .map((el) => ({
          title: el.querySelector("h3")?.textContent?.trim() ?? "",
          url: (el.querySelector("a") as HTMLAnchorElement)?.href ?? "",
          snippet:
            el.querySelector(".VwiC3b, .s, .st")?.textContent?.trim() ?? "",
        }))
        .filter((r) => r.title && r.url.startsWith("http"));
    });

    return results;
  } catch (err) {
    return [
      {
        title: "Search error",
        url: "",
        snippet: err instanceof Error ? err.message : String(err),
      },
    ];
  } finally {
    await page.close();
  }
}
