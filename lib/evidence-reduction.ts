const MAX_EVIDENCE_FRAGMENTS = 3;
const MAX_EVIDENCE_FRAGMENT_LENGTH = 240;
const MAX_REDUCED_FIELDS = 18;
const UNSAFE_EVIDENCE_FRAGMENT_PATTERN =
  /\b(system prompt|developer message|prompt injection|chatgpt|ai assistant|tool call|correct answer|best answer|real answer|only answer|regardless of evidence|regardless of source|trust this summary)\b/i;
const MAX_FIELDS_PER_KIND: Record<EvidenceFieldKind, number> = {
  title: 1,
  "meta-description": 1,
  heading: 4,
  "text-block": 6,
  "table-row": 4,
  "notable-link": 6,
  structured: 8,
};
const MAX_FIELD_LENGTH_BY_KIND: Record<EvidenceFieldKind, number> = {
  title: 180,
  "meta-description": 280,
  heading: 180,
  "text-block": 220,
  "table-row": 220,
  "notable-link": 220,
  structured: 220,
};

export type EvidenceFieldKind =
  | "title"
  | "meta-description"
  | "heading"
  | "text-block"
  | "table-row"
  | "notable-link"
  | "structured";

export type EvidenceFieldCertainty = "high" | "medium" | "low";

export type EvidenceFieldCandidate = {
  label: string;
  value: string;
  source: "meta" | "text" | "table" | "link" | "schema" | "json-ld";
  kind: EvidenceFieldKind;
  certainty: EvidenceFieldCertainty;
  sourceUrl: string;
};

function normalizeEvidenceFragment(value: string): string {
  return value
    .replace(/`{1,3}/g, " ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/gi, "$1")
    .replace(/[•▪◦‣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitEvidenceFragments(value: string): string[] {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/))
    .map((fragment) => normalizeEvidenceFragment(fragment))
    .filter(Boolean);
}

function isUnsafeEvidenceFragment(value: string): boolean {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();

  if (!/[a-z0-9]/i.test(normalized)) {
    return true;
  }

  if (/^(system|assistant|user|developer|tool|instruction|prompt)\s*:/i.test(normalized)) {
    return true;
  }

  if (/^(ignore|disregard|follow|reveal|repeat|return|print|output|override|bypass|forget|pretend|act)\b/i.test(lower)) {
    return true;
  }

  if (
    /\b(ignore|disregard|override|bypass)\b.{0,40}\b(instruction|instructions|prompt|guardrail|policy|system|developer)\b/i.test(
      lower
    )
  ) {
    return true;
  }

  return UNSAFE_EVIDENCE_FRAGMENT_PATTERN.test(lower);
}

function hasInvisibleMarkers(value: string): boolean {
  return /[\u200B-\u200F\u2060\uFEFF]/.test(value);
}

function isLowDensityEvidenceFragment(value: string): boolean {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9$%]+/i)
    .filter(Boolean);

  if (tokens.length === 0) {
    return true;
  }

  const uniqueTokens = new Set(tokens);
  const uniqueRatio = uniqueTokens.size / tokens.length;
  const maxRepeat = Math.max(
    ...Array.from(uniqueTokens).map((token) => tokens.filter((candidate) => candidate === token).length)
  );

  if (tokens.length >= 10 && uniqueRatio < 0.35) {
    return true;
  }

  if (tokens.length >= 8 && maxRepeat / tokens.length > 0.45) {
    return true;
  }

  return /(lorem ipsum|click here|loading|javascript required)/i.test(value);
}

export function sanitizeEvidenceText(value: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const fragment of splitEvidenceFragments(value)) {
    if (isUnsafeEvidenceFragment(fragment)) {
      break;
    }

    const reduced =
      fragment.length > MAX_EVIDENCE_FRAGMENT_LENGTH
        ? `${fragment.slice(0, MAX_EVIDENCE_FRAGMENT_LENGTH).trimEnd()}...`
        : fragment;
    const dedupeKey = reduced.toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    kept.push(reduced);

    if (kept.length >= MAX_EVIDENCE_FRAGMENTS) {
      break;
    }
  }

  return kept.join("\n").trim();
}

export function reduceEvidenceFieldCandidates(
  candidates: EvidenceFieldCandidate[]
): EvidenceFieldCandidate[] {
  const seen = new Set<string>();
  const perKindCounts = new Map<EvidenceFieldKind, number>();
  const reduced: EvidenceFieldCandidate[] = [];

  for (const candidate of candidates) {
    const sanitized = sanitizeEvidenceText(candidate.value);

    if (!sanitized || hasInvisibleMarkers(candidate.value) || isLowDensityEvidenceFragment(sanitized)) {
      continue;
    }

    const limited =
      sanitized.length > MAX_FIELD_LENGTH_BY_KIND[candidate.kind]
        ? `${sanitized.slice(0, MAX_FIELD_LENGTH_BY_KIND[candidate.kind]).trimEnd()}...`
        : sanitized;
    const dedupeKey = `${candidate.kind}:${candidate.sourceUrl}:${limited.toLowerCase()}`;

    if (seen.has(dedupeKey)) {
      continue;
    }

    const nextKindCount = (perKindCounts.get(candidate.kind) ?? 0) + 1;

    if (nextKindCount > MAX_FIELDS_PER_KIND[candidate.kind]) {
      continue;
    }

    perKindCounts.set(candidate.kind, nextKindCount);
    seen.add(dedupeKey);
    reduced.push({
      ...candidate,
      value: limited,
    });

    if (reduced.length >= MAX_REDUCED_FIELDS) {
      break;
    }
  }

  return reduced;
}
