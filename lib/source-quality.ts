import type { EvidenceDocument } from "@/lib/browser";

export type SourceClass = "official" | "editorial" | "directory" | "community" | "reference" | "other";

export interface SourceQualityAssessment {
  url: string;
  domain: string;
  sourceClass: SourceClass;
  score: number;
  primary: boolean;
  official: boolean;
  dateAvailable: boolean;
  authorAvailable: boolean;
  structuredDataQuality: number;
  contentTypeQuality: number;
  domainReputation: number;
  allowlisted: boolean;
  denylisted: boolean;
  promptRelevance: number;
  evidenceDensity: number;
}

export interface SourceQualitySummary {
  averageScore: number;
  primarySourceCount: number;
  officialSourceCount: number;
  dateAvailableSourceCount: number;
  authorAvailableSourceCount: number;
  strongestSourceUrls: string[];
}

const DATE_SIGNAL_PATTERN =
  /\b(?:20\d{2}|19\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|updated|published|released|last modified)\b/i;
const AUTHOR_SIGNAL_PATTERN = /\b(?:author|byline|written by|posted by|publisher)\b/i;
const PROMPT_TOKEN_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "about",
  "what",
  "when",
  "where",
  "which",
  "their",
  "there",
  "have",
  "will",
  "your",
]);

export function getDomainForUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function classifySourceClass(url: string): SourceClass {
  const domain = getDomainForUrl(url);
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const combined = `${domain}${pathname}`;

  if (
    combined.includes("docs") ||
    combined.includes("developer") ||
    combined.includes("support") ||
    combined.includes("help") ||
    combined.includes("knowledge-base")
  ) {
    return "official";
  }

  if (
    combined.includes("news") ||
    combined.includes("press") ||
    combined.includes("blog") ||
    combined.includes("journal") ||
    combined.includes("magazine") ||
    combined.includes("medium.com") ||
    combined.includes("substack.com")
  ) {
    return "editorial";
  }

  if (
    combined.includes("github.com") ||
    combined.includes("gitlab.com") ||
    combined.includes("reddit.com") ||
    combined.includes("stackoverflow.com") ||
    combined.includes("forum") ||
    combined.includes("community")
  ) {
    return "community";
  }

  if (
    combined.includes("directory") ||
    combined.includes("compare") ||
    combined.includes("alternatives") ||
    combined.includes("list") ||
    combined.includes("rank")
  ) {
    return "directory";
  }

  if (
    combined.includes("wikipedia.org") ||
    combined.includes("crunchbase.com") ||
    combined.includes("linkedin.com") ||
    combined.includes("g2.com") ||
    combined.includes("capterra.com") ||
    combined.includes("arxiv.org") ||
    combined.includes("pubmed")
  ) {
    return "reference";
  }

  return "other";
}

export function scoreUrlSourceQuality(url: string): number {
  switch (classifySourceClass(url)) {
    case "official":
      return 100;
    case "reference":
      return 80;
    case "editorial":
      return 60;
    case "directory":
      return 45;
    case "community":
      return 35;
    default:
      return 20;
  }
}

function tokenizePrompt(prompt: string): string[] {
  return Array.from(
    new Set(
      prompt
        .toLowerCase()
        .match(/[a-z0-9]{3,}/g)
        ?.filter((token) => !PROMPT_TOKEN_STOPWORDS.has(token)) ?? []
    )
  ).slice(0, 24);
}

function scorePromptRelevance(prompt: string, text: string): number {
  const promptTokens = tokenizePrompt(prompt);

  if (promptTokens.length === 0) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  const matchedTokens = promptTokens.filter((token) => normalizedText.includes(token));
  return Math.min(matchedTokens.length * 2, 12);
}

function scoreDomainReputation(sourceClass: SourceClass, domain: string): {
  score: number;
  allowlisted: boolean;
  denylisted: boolean;
} {
  const allowlisted =
    sourceClass === "official" ||
    /(?:wikipedia\.org|pubmed|arxiv\.org|docs\.|developer\.|support\.)/i.test(domain);
  const denylisted = /(?:reddit\.com|forum|community|compare|alternatives|rank)/i.test(domain);

  const baseScore =
    sourceClass === "official"
      ? 18
      : sourceClass === "reference"
        ? 15
        : sourceClass === "editorial"
          ? 10
          : sourceClass === "directory"
            ? 6
            : sourceClass === "community"
              ? 4
              : 3;

  return {
    score: Math.max(baseScore + (allowlisted ? 4 : 0) - (denylisted ? 3 : 0), 0),
    allowlisted,
    denylisted,
  };
}

export function assessEvidenceDocumentQuality(
  document: EvidenceDocument,
  prompt: string
): SourceQualityAssessment {
  const sourceClass = classifySourceClass(document.finalUrl);
  const domain = getDomainForUrl(document.finalUrl);
  const populatedEvidenceFields = document.evidenceFields.filter((field) => Boolean(field.value.trim()));
  const structuredFieldCount = populatedEvidenceFields.filter(
    (field) => field.source === "schema" || field.source === "json-ld" || field.kind === "structured"
  ).length;
  const dateAvailable = populatedEvidenceFields.some(
    (field) => DATE_SIGNAL_PATTERN.test(field.value) || DATE_SIGNAL_PATTERN.test(field.label)
  );
  const authorAvailable = populatedEvidenceFields.some(
    (field) => AUTHOR_SIGNAL_PATTERN.test(field.value) || AUTHOR_SIGNAL_PATTERN.test(field.label)
  );
  const contentTypeQuality = /(?:text\/html|application\/json)/i.test(document.contentType) ? 8 : 4;
  const structuredDataQuality = Math.min(structuredFieldCount * 6, 18);
  const evidenceDensity = Math.min(populatedEvidenceFields.length * 2, 18);
  const promptRelevance = scorePromptRelevance(
    prompt,
    [document.title, ...populatedEvidenceFields.slice(0, 8).map((field) => field.value)].join(" ")
  );
  const reputation = scoreDomainReputation(sourceClass, domain);
  const official = sourceClass === "official";
  const primary = official || /\.(?:gov|edu)$/i.test(domain);
  const score = Math.min(
    scoreUrlSourceQuality(document.finalUrl) / 5 +
      structuredDataQuality +
      contentTypeQuality +
      evidenceDensity +
      promptRelevance +
      reputation.score +
      (dateAvailable ? 6 : 0) +
      (authorAvailable ? 4 : 0) +
      (primary ? 10 : 0),
    100
  );

  return {
    url: document.finalUrl,
    domain,
    sourceClass,
    score,
    primary,
    official,
    dateAvailable,
    authorAvailable,
    structuredDataQuality,
    contentTypeQuality,
    domainReputation: reputation.score,
    allowlisted: reputation.allowlisted,
    denylisted: reputation.denylisted,
    promptRelevance,
    evidenceDensity,
  };
}

export function summarizeSourceQuality(assessments: SourceQualityAssessment[]): SourceQualitySummary {
  if (assessments.length === 0) {
    return {
      averageScore: 0,
      primarySourceCount: 0,
      officialSourceCount: 0,
      dateAvailableSourceCount: 0,
      authorAvailableSourceCount: 0,
      strongestSourceUrls: [],
    };
  }

  const strongestSourceUrls = [...assessments]
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
    .slice(0, 3)
    .map((assessment) => assessment.url);

  return {
    averageScore: Number(
      (assessments.reduce((total, assessment) => total + assessment.score, 0) / assessments.length).toFixed(1)
    ),
    primarySourceCount: assessments.filter((assessment) => assessment.primary).length,
    officialSourceCount: assessments.filter((assessment) => assessment.official).length,
    dateAvailableSourceCount: assessments.filter((assessment) => assessment.dateAvailable).length,
    authorAvailableSourceCount: assessments.filter((assessment) => assessment.authorAvailable).length,
    strongestSourceUrls,
  };
}

export function isTimeSensitivePrompt(prompt: string): boolean {
  return /\b(?:latest|current|recent|today|now|pricing|price|version|release|released|availability|202\d)\b/i.test(
    prompt
  );
}
