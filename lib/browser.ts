import {
  chromium,
  Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  reduceEvidenceFieldCandidates,
  type EvidenceFieldCandidate,
  type EvidenceFieldCertainty,
  type EvidenceFieldKind,
} from "@/lib/evidence-reduction";

let browser: Browser | null = null;
const MAX_SEARCH_RESULTS = 6;
const MAX_EXTRACTED_CHARACTERS = 8000;
const MAX_EVIDENCE_SNIPPETS = 8;
const blockedUrlValidationCache = new Map<string, Promise<void>>();

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchDiagnostics = {
  provider: SearchProviderName;
  degraded: boolean;
  attemptedProviders: SearchProviderName[];
  results: SearchResult[];
};

export interface BrowseResult {
  url: string;
  title: string;
  content: string;
  sourceUrls: string[];
  evidenceSnippets: string[];
  structuredData?: StructuredPageData;
  evidenceDocument: EvidenceDocument;
}

export interface EvidenceField {
  id: string;
  label: string;
  value: string;
  source: "meta" | "text" | "table" | "link" | "schema" | "json-ld";
  kind: EvidenceFieldKind;
  certainty: EvidenceFieldCertainty;
  sourceUrl: string;
  untrusted: true;
}

export interface EvidenceDocument {
  finalUrl: string;
  canonicalUrl?: string;
  title: string;
  contentType: string;
  sourceUrls: string[];
  redirectChain: string[];
  evidenceFields: EvidenceField[];
  evidenceSnippets: string[];
  untrusted: true;
}

export type SearchProviderName = "serper" | "brave" | "duckduckgo";

type SearchAdapter = {
  name: SearchProviderName;
  search: (query: string) => Promise<SearchResult[]>;
};

type RawStructuredBrowseData = {
  canonicalUrl?: string;
  openGraph?: Record<string, string>;
  schemaFields?: Array<{ name: string; value: string }>;
  jsonLdBlocks?: string[];
};

export interface StructuredPageData {
  canonicalUrl?: string;
  openGraph?: Record<string, string>;
  schemaFields?: Record<string, string>;
  jsonLd?: Array<{
    type: string;
    properties: Record<string, string>;
  }>;
}

const COMMON_SCHEMA_FIELD_NAMES = new Set([
  "name",
  "headline",
  "description",
  "brand",
  "price",
  "pricecurrency",
  "availability",
  "url",
  "sameas",
  "author",
  "publisher",
  "datepublished",
  "datemodified",
  "startdate",
  "enddate",
  "jobtitle",
  "addresslocality",
  "addressregion",
]);
const MAX_JSON_LD_ITEMS = 4;
const MAX_JSON_LD_PROPERTIES = 6;
const MAX_STRUCTURED_SUMMARY_LINES = 12;

function normalizeStructuredText(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStructuredText(entry)).filter(Boolean).join(", ");
  }

  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;

    for (const key of ["name", "headline", "title", "url", "price", "priceCurrency"]) {
      const normalized = normalizeStructuredText(candidate[key]);

      if (normalized) {
        return normalized;
      }
    }
  }

  return "";
}

function normalizeHttpUrlCandidate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function collectJsonLdNodes(value: unknown): Record<string, unknown>[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectJsonLdNodes(entry));
  }

  if (typeof value !== "object") {
    return [];
  }

  const candidate = value as Record<string, unknown>;
  const graphNodes = collectJsonLdNodes(candidate["@graph"]);

  return [candidate, ...graphNodes];
}

function summarizeJsonLdNode(node: Record<string, unknown>) {
  const rawType = node["@type"];
  const type = normalizeStructuredText(Array.isArray(rawType) ? rawType[0] : rawType) || "Thing";
  const properties: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(node)) {
    if (key.startsWith("@") || properties[key]) {
      continue;
    }

    const normalizedKey = key.toLowerCase();

    if (!COMMON_SCHEMA_FIELD_NAMES.has(normalizedKey)) {
      continue;
    }

    const normalizedValue = normalizeStructuredText(rawValue);

    if (normalizedValue) {
      properties[key] = normalizedValue;
    }

    if (Object.keys(properties).length >= MAX_JSON_LD_PROPERTIES) {
      break;
    }
  }

  return Object.keys(properties).length > 0 ? { type, properties } : undefined;
}

export function normalizeStructuredPageData(
  raw: RawStructuredBrowseData | undefined
): StructuredPageData | undefined {
  if (!raw) {
    return undefined;
  }

  const canonicalUrl = normalizeHttpUrlCandidate(normalizeStructuredText(raw.canonicalUrl));
  const openGraph = Object.fromEntries(
    Object.entries(raw.openGraph ?? {})
      .map(([key, value]) => [key.trim().toLowerCase(), normalizeStructuredText(value)])
      .filter(([, value]) => Boolean(value))
  );
  const schemaFields = Object.fromEntries(
    (raw.schemaFields ?? [])
      .map((entry) => [entry.name.trim(), normalizeStructuredText(entry.value)])
      .filter(([name, value]) => Boolean(name) && Boolean(value))
  );
  const jsonLd = (raw.jsonLdBlocks ?? [])
    .flatMap((block) => {
      try {
        return collectJsonLdNodes(JSON.parse(block));
      } catch {
        return [];
      }
    })
    .map((node) => summarizeJsonLdNode(node))
    .filter((entry): entry is NonNullable<ReturnType<typeof summarizeJsonLdNode>> => Boolean(entry))
    .slice(0, MAX_JSON_LD_ITEMS);

  if (
    !canonicalUrl &&
    Object.keys(openGraph).length === 0 &&
    Object.keys(schemaFields).length === 0 &&
    jsonLd.length === 0
  ) {
    return undefined;
  }

  return {
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(Object.keys(openGraph).length > 0 ? { openGraph } : {}),
    ...(Object.keys(schemaFields).length > 0 ? { schemaFields } : {}),
    ...(jsonLd.length > 0 ? { jsonLd } : {}),
  };
}

export function buildStructuredDataLines(structuredData: StructuredPageData | undefined): string[] {
  if (!structuredData) {
    return [];
  }

  const lines: string[] = [];
  const push = (label: string, value: string | undefined) => {
    const normalizedValue = normalizeStructuredText(value);

    if (!normalizedValue || lines.length >= MAX_STRUCTURED_SUMMARY_LINES) {
      return;
    }

    lines.push(`${label}: ${normalizedValue}`);
  };

  push("Canonical URL", structuredData.canonicalUrl);
  push("Open Graph title", structuredData.openGraph?.["og:title"]);
  push("Open Graph description", structuredData.openGraph?.["og:description"]);
  push("Open Graph type", structuredData.openGraph?.["og:type"]);
  push("Open Graph URL", structuredData.openGraph?.["og:url"]);

  for (const [name, value] of Object.entries(structuredData.schemaFields ?? {})) {
    push(`Schema ${name}`, value);
  }

  for (const entry of structuredData.jsonLd ?? []) {
    for (const [name, value] of Object.entries(entry.properties)) {
      push(`JSON-LD ${entry.type}.${name}`, value);
    }
  }

  return lines;
}

function collectStructuredSourceUrls(structuredData: StructuredPageData | undefined): string[] {
  if (!structuredData) {
    return [];
  }

  const urls = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = normalizeHttpUrlCandidate(normalizeStructuredText(value));

    if (normalized) {
      urls.add(normalized);
    }
  };

  add(structuredData.canonicalUrl);
  add(structuredData.openGraph?.["og:url"]);

  for (const [name, value] of Object.entries(structuredData.schemaFields ?? {})) {
    if (name.toLowerCase().includes("url") || name.toLowerCase() === "sameas") {
      value
        .split(/\s*,\s*/)
        .forEach((entry) => add(entry));
    }
  }

  for (const entry of structuredData.jsonLd ?? []) {
    for (const [name, value] of Object.entries(entry.properties)) {
      if (name.toLowerCase().includes("url") || name.toLowerCase() === "sameas") {
        value
          .split(/\s*,\s*/)
          .forEach((candidate) => add(candidate));
      }
    }
  }

  return Array.from(urls);
}

function collapseLines(lines: string[], maxCharacters: number): string {
  const kept: string[] = [];
  let currentLength = 0;

  for (const line of lines) {
    const normalized = normalizeStructuredText(line);

    if (!normalized || kept.includes(normalized)) {
      continue;
    }

    const nextLength = currentLength + normalized.length + 1;

    if (nextLength > maxCharacters && kept.length > 0) {
      break;
    }

    kept.push(normalized);
    currentLength = nextLength;
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildEvidenceDocument(input: {
  finalUrl: string;
  title: string;
  metaDescription?: string;
  contentType: string;
  redirectChain: string[];
  sourceUrls: string[];
  headings: string[];
  textBlocks: string[];
  notableLinks: Array<{ label: string; url: string }>;
  tableRows: string[];
  structuredData?: StructuredPageData;
}): EvidenceDocument {
  const candidates: EvidenceFieldCandidate[] = [];
  const push = (
    label: string,
    value: string | undefined,
    source: EvidenceField["source"],
    kind: EvidenceFieldKind,
    certainty: EvidenceFieldCertainty,
    sourceUrl = input.finalUrl
  ) => {
    if (!value?.trim()) {
      return;
    }

    candidates.push({
      label,
      value,
      source,
      kind,
      certainty,
      sourceUrl,
    });
  };

  push("Page title", input.title, "meta", "title", "high");
  push("Meta description", input.metaDescription, "meta", "meta-description", "high");

  for (const heading of input.headings) {
    push("Heading", heading, "text", "heading", "medium");
  }

  for (const block of input.textBlocks) {
    push("Text block", block, "text", "text-block", "low");
  }

  for (const row of input.tableRows) {
    push("Table row", row, "table", "table-row", "medium");
  }

  for (const link of input.notableLinks) {
    push("Notable link", `${link.label}: ${link.url}`, "link", "notable-link", "medium", link.url);
  }

  for (const line of buildStructuredDataLines(input.structuredData)) {
    push(
      "Structured evidence",
      line,
      line.startsWith("JSON-LD") ? "json-ld" : "schema",
      "structured",
      "high"
    );
  }

  const documentId = createHash("sha256").update(input.finalUrl).digest("hex").slice(0, 8);
  const evidenceFields: EvidenceField[] = reduceEvidenceFieldCandidates(candidates).map((field, index) => ({
    id: `${documentId}-f${index + 1}`,
    ...field,
    untrusted: true,
  }));
  const evidenceSnippets = evidenceFields
    .map((field) => `[${field.id}] ${field.label}: ${field.value}`)
    .slice(0, MAX_EVIDENCE_SNIPPETS);

  return {
    finalUrl: input.finalUrl,
    canonicalUrl: input.structuredData?.canonicalUrl,
    title: input.title,
    contentType: input.contentType,
    redirectChain: input.redirectChain,
    sourceUrls: input.sourceUrls,
    evidenceFields,
    evidenceSnippets,
    untrusted: true,
  };
}

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

async function allowOnlyPublicRequests(route: Route): Promise<void> {
  try {
    await validatePublicHttpUrl(route.request().url());
    await route.continue();
  } catch {
    await route.abort();
  }
}

async function createIsolatedPage(): Promise<{ context: BrowserContext; page: Page }> {
  const b = await getBrowser();
  const context = await b.newContext({
    serviceWorkers: "block",
  });

  await context.route("**/*", allowOnlyPublicRequests);

  return {
    context,
    page: await context.newPage(),
  };
}

function normalizeIpAddress(value: string): string {
  const unwrapped = value.replace(/^\[|\]$/g, "").toLowerCase();

  if (unwrapped.startsWith("::ffff:")) {
    const mapped = unwrapped.slice(7);

    if (isIP(mapped) === 4) {
      return mapped;
    }
  }

  return unwrapped;
}

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .map((part) => Number(part))
    .reduce((total, part) => ((total << 8) | part) >>> 0, 0);
}

function expandIpv6(address: string): number[] {
  const normalized = normalizeIpAddress(address);
  const [head, tail] = normalized.split("::");
  const convertParts = (value: string) =>
    value
      .split(":")
      .filter(Boolean)
      .flatMap((part) => {
        if (!part.includes(".")) {
          return [parseInt(part, 16)];
        }

        const ipv4 = part.split(".").map((segment) => Number(segment));
        return [((ipv4[0] << 8) | ipv4[1]) >>> 0, ((ipv4[2] << 8) | ipv4[3]) >>> 0];
      });
  const headParts = convertParts(head ?? "");
  const tailParts = convertParts(tail ?? "");
  const missingGroups = 8 - (headParts.length + tailParts.length);

  return [
    ...headParts,
    ...Array.from({ length: Math.max(missingGroups, 0) }, () => 0),
    ...tailParts,
  ];
}

function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  const ranges: Array<[number, number]> = [
    [ipv4ToNumber("0.0.0.0"), ipv4ToNumber("0.255.255.255")],
    [ipv4ToNumber("10.0.0.0"), ipv4ToNumber("10.255.255.255")],
    [ipv4ToNumber("100.64.0.0"), ipv4ToNumber("100.127.255.255")],
    [ipv4ToNumber("127.0.0.0"), ipv4ToNumber("127.255.255.255")],
    [ipv4ToNumber("169.254.0.0"), ipv4ToNumber("169.254.255.255")],
    [ipv4ToNumber("172.16.0.0"), ipv4ToNumber("172.31.255.255")],
    [ipv4ToNumber("192.168.0.0"), ipv4ToNumber("192.168.255.255")],
    [ipv4ToNumber("224.0.0.0"), ipv4ToNumber("255.255.255.255")],
  ];

  return ranges.some(([start, end]) => value >= start && value <= end);
}

function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6(address);

  if (groups.every((group) => group === 0)) {
    return true;
  }

  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true;
  }

  if (groups[0] >= 0xfc00 && groups[0] <= 0xfdff) {
    return true;
  }

  if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) {
    return true;
  }

  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    return isPrivateIpv4(
      [
        (groups[6] >>> 8) & 255,
        groups[6] & 255,
        (groups[7] >>> 8) & 255,
        groups[7] & 255,
      ].join(".")
    );
  }

  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
}

function isBlockedIpAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  const version = isIP(normalized);

  if (version === 4) {
    return isPrivateIpv4(normalized);
  }

  if (version === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

export async function validatePublicHttpUrl(target: string): Promise<void> {
  let validation = blockedUrlValidationCache.get(target);

  if (!validation) {
    validation = (async () => {
      let parsed: URL;

      try {
        parsed = new URL(target);
      } catch {
        throw new Error("Only valid public http(s) URLs can be browsed.");
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only public http(s) URLs can be browsed.");
      }

      if (parsed.username || parsed.password) {
        throw new Error("Credentialed URLs are not allowed.");
      }

      if (isBlockedHostname(parsed.hostname) || isBlockedIpAddress(parsed.hostname)) {
        throw new Error("Local, private, and link-local addresses are blocked.");
      }

      const resolvedAddresses = await lookup(parsed.hostname, { all: true, verbatim: true });

      if (
        resolvedAddresses.length === 0 ||
        resolvedAddresses.some((entry) => isBlockedIpAddress(entry.address))
      ) {
        throw new Error("Only public internet hosts can be browsed.");
      }
    })();

    blockedUrlValidationCache.set(target, validation);
  }

  try {
    await validation;
  } catch (error) {
    blockedUrlValidationCache.delete(target);
    throw error;
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

async function searchWithBrave(query: string): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is not configured.");
  }

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_SEARCH_RESULTS}`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Brave search failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    web?: {
      results?: Array<{ title?: string; url?: string; description?: string }>;
    };
  };

  return normalizeSearchResults(
    (payload.web?.results ?? []).map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
      snippet: result.description ?? "",
    }))
  );
}

async function searchWithDuckDuckGo(query: string): Promise<SearchResult[]> {
  const { context, page } = await createIsolatedPage();

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
    await context.close();
  }
}

const SEARCH_ADAPTER_FACTORIES: Record<SearchProviderName, () => SearchAdapter> = {
  serper: () => ({ name: "serper", search: searchWithSerper }),
  brave: () => ({ name: "brave", search: searchWithBrave }),
  duckduckgo: () => ({ name: "duckduckgo", search: searchWithDuckDuckGo }),
};

export function getConfiguredSearchProviders(env: NodeJS.ProcessEnv = process.env): SearchProviderName[] {
  const configuredProviders = (env.SEARCH_PROVIDERS ?? "")
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider): provider is SearchProviderName => provider in SEARCH_ADAPTER_FACTORIES);

  if (configuredProviders.length > 0) {
    return Array.from(new Set(configuredProviders));
  }

  const providers: SearchProviderName[] = [];

  if (env.SERPER_API_KEY?.trim()) {
    providers.push("serper");
  }

  if (env.BRAVE_SEARCH_API_KEY?.trim()) {
    providers.push("brave");
  }

  providers.push("duckduckgo");
  return Array.from(new Set(providers));
}

export function isDegradedSearchProvider(provider: SearchProviderName): boolean {
  return provider === "duckduckgo";
}

/** Navigate to a URL and extract readable text content */
export async function browseAndExtract(url: string): Promise<BrowseResult> {
  const { context, page } = await createIsolatedPage();

  try {
    await validatePublicHttpUrl(url);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForSettledPage(page);

    const redirectChain: string[] = [];
    let redirectedRequest = response?.request() ?? null;

    while (redirectedRequest) {
      redirectChain.unshift(redirectedRequest.url());
      redirectedRequest = redirectedRequest.redirectedFrom();
    }

    for (const hop of redirectChain) {
      await validatePublicHttpUrl(hop);
    }

    await validatePublicHttpUrl(page.url());

    const contentType = response?.headers()["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";

    if (!contentType || !["text/html", "application/xhtml+xml"].includes(contentType)) {
      throw new Error(`Unsupported content type "${contentType || "unknown"}".`);
    }

    const content = await page.evaluate(({ maxEvidenceSnippets }) => {
      const root =
        document.querySelector("main, article, [role='main'], .main, #main") ??
        document.body;
      const container = root.cloneNode(true) as HTMLElement;
      const isVisible = (element: Element | null) => {
        if (!element || element.closest("[hidden], [aria-hidden='true']")) {
          return false;
        }

        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      };

      container
        .querySelectorAll(
          "script,style,noscript,iframe,svg,canvas,form,button,input,select,textarea,.cookie,.popup,.modal,.ad,.advertisement,[aria-hidden='true']"
        )
        .forEach((el) => el.remove());

      const pushUnique = (bucket: string[], value?: string | null) => {
        const nextValue = value?.replace(/\s+/g, " ").trim();

        if (!nextValue || bucket.includes(nextValue)) {
          return;
        }

        bucket.push(nextValue);
      };

      const headings: string[] = [];
      const textBlocks: string[] = [];
      const tableRows: string[] = [];
      const notableLinks: Array<{ label: string; url: string }> = [];
      const metaDescription = document.querySelector("meta[name='description']")?.getAttribute("content") ?? "";

      Array.from(container.querySelectorAll("h1, h2, h3"))
        .filter((element) => isVisible(element))
        .map((element) => element.textContent)
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim())
        .filter(Boolean)
        .forEach((value) => pushUnique(headings, value));

      Array.from(container.querySelectorAll("p, li, blockquote, pre"))
        .filter((element) => isVisible(element))
        .map((element) => element.textContent)
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim())
        .filter(Boolean)
        .forEach((value) => pushUnique(textBlocks, value));

      for (const row of Array.from(container.querySelectorAll("table")).slice(0, 3)) {
        if (!isVisible(row)) {
          continue;
        }

        for (const tableRow of Array.from(row.querySelectorAll("tr"))) {
          if (!isVisible(tableRow)) {
            continue;
          }

          pushUnique(
            tableRows,
            Array.from(tableRow.querySelectorAll("th, td"))
              .map((cell) => cell.textContent?.replace(/\s+/g, " ").trim() ?? "")
              .filter(Boolean)
              .join(" | ")
          );
        }
      }

      Array.from(container.querySelectorAll("a[href]"))
        .filter((link) => isVisible(link))
        .slice(0, 8)
        .forEach((link) => {
          const label = link.textContent?.replace(/\s+/g, " ").trim() ?? "";
          const href = link.getAttribute("href") ?? "";

          if (!label || !href) {
            return;
          }

          try {
            const absoluteUrl = new URL(href, document.baseURI).toString();
            notableLinks.push({ label, url: absoluteUrl });
          } catch {
            return;
          }
        });

      const openGraph = Object.fromEntries(
        Array.from(document.querySelectorAll("meta[property]"))
          .map((meta) => [
            meta.getAttribute("property")?.trim() ?? "",
            meta.getAttribute("content")?.replace(/\s+/g, " ").trim() ?? "",
          ])
          .filter(([name, value]) => name.startsWith("og:") && Boolean(value))
      );
      const schemaFields = Array.from(container.querySelectorAll("[itemprop]"))
        .slice(0, 24)
        .map((element) => {
          const name = element.getAttribute("itemprop")?.trim() ?? "";
          const value =
            element.getAttribute("content")?.replace(/\s+/g, " ").trim() ??
            element.textContent?.replace(/\s+/g, " ").trim() ??
            "";

          return { name, value };
        })
        .filter((entry) => entry.name && entry.value);
      const jsonLdBlocks = Array.from(
        document.querySelectorAll("script[type='application/ld+json']")
      )
        .map((script) => script.textContent?.trim() ?? "")
        .filter(Boolean)
        .slice(0, 6);

        return {
          title: document.title.trim(),
          metaDescription,
          headings,
          textBlocks,
          notableLinks,
          tableRows,
          sourceUrls: Array.from(new Set([document.location.href, ...notableLinks.map((entry) => entry.url)])),
          evidenceSnippets: [...headings, ...textBlocks].slice(0, maxEvidenceSnippets),
          structured: {
          canonicalUrl: document.querySelector("link[rel='canonical']")?.getAttribute("href") ?? "",
          openGraph,
          schemaFields,
          jsonLdBlocks,
        },
      };
    }, { maxEvidenceSnippets: MAX_EVIDENCE_SNIPPETS });

    const structuredData = normalizeStructuredPageData(content.structured);
    const mergedSourceUrls = Array.from(
      new Set([
        ...content.sourceUrls,
        ...collectStructuredSourceUrls(structuredData),
      ])
    ).slice(0, MAX_SEARCH_RESULTS + 2);
    const evidenceDocument = buildEvidenceDocument({
      finalUrl: page.url(),
      title: content.title,
      metaDescription: content.metaDescription,
      contentType,
      redirectChain,
      sourceUrls: mergedSourceUrls,
      headings: content.headings,
      textBlocks: content.textBlocks,
      notableLinks: content.notableLinks,
      tableRows: content.tableRows,
      structuredData,
    });

    return {
      url: page.url(),
      title: content.title,
      content: collapseLines(
        evidenceDocument.evidenceFields.map((field) => `${field.label}: ${field.value}`),
        MAX_EXTRACTED_CHARACTERS
      ) || "No content extracted.",
      sourceUrls: mergedSourceUrls,
      evidenceSnippets: evidenceDocument.evidenceSnippets,
      evidenceDocument,
      ...(structuredData ? { structuredData } : {}),
    };
  } finally {
    await context.close();
  }
}

/** Search the configured provider and return top result URLs + snippets */
export async function searchWeb(
  query: string
): Promise<SearchResult[]> {
  const search = await searchWebWithDiagnostics(query);
  return search.results;
}

export async function searchWebWithDiagnostics(
  query: string
): Promise<SearchDiagnostics> {
  if (!query.trim()) {
    throw new Error("Search query cannot be empty.");
  }

  const configuredProviders = getConfiguredSearchProviders();
  const attemptedProviders: SearchProviderName[] = [];
  const attemptedProviderErrors: string[] = [];
  let lastError: unknown = null;

  for (const provider of configuredProviders) {
    const adapter = SEARCH_ADAPTER_FACTORIES[provider]();
    const providerName = adapter.name;

    try {
      return {
        provider: providerName,
        degraded: isDegradedSearchProvider(providerName),
        attemptedProviders,
        results: await adapter.search(query),
      };
    } catch (error) {
      attemptedProviders.push(providerName);
      attemptedProviderErrors.push(
        `${providerName} (${error instanceof Error ? error.message : String(error)})`
      );
      lastError = error;
    }
  }

  throw new Error(
    `Search failed. Attempted providers: ${configuredProviders.join(", ")}. Errors: ${
      attemptedProviderErrors.length > 0
        ? attemptedProviderErrors.join("; ")
        : lastError instanceof Error
          ? lastError.message
          : String(lastError)
    }`
  );
}
