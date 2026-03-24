const MAX_EVIDENCE_FRAGMENTS = 3;
const MAX_EVIDENCE_FRAGMENT_LENGTH = 240;

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

  return /\b(system prompt|developer message|prompt injection|chatgpt|ai assistant|tool call)\b/i.test(lower);
}

export function sanitizeEvidenceText(value: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const fragment of splitEvidenceFragments(value)) {
    if (isUnsafeEvidenceFragment(fragment)) {
      continue;
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
