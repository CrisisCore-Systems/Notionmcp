export interface EvidenceCitationReference {
  snippet: string;
  sourceUrl: string;
}

export interface EvidenceAgreementAssessment {
  matchingSourceUrls: string[];
  conflictingSourceUrls: string[];
  agreementRatio: number;
  unresolvedDirectContradiction: boolean;
}

export function extractComparableTokens(value: string): string[] {
  return Array.from(
    new Set(
      (value.toLowerCase().match(
        /\b\d[\d.,%$-]*\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\b|\b(?:available|unavailable|free|paid|monthly|annual)\b/g
      ) ?? [])
    )
  );
}

export function assessCitationAgreement(
  fieldValue: string,
  citations: EvidenceCitationReference[]
): EvidenceAgreementAssessment {
  const expectedTokens = extractComparableTokens(fieldValue);

  if (expectedTokens.length === 0) {
    return {
      matchingSourceUrls: citations.map((citation) => citation.sourceUrl),
      conflictingSourceUrls: [],
      agreementRatio: citations.length > 0 ? 1 : 0,
      unresolvedDirectContradiction: false,
    };
  }

  const matchingSourceUrls = new Set<string>();
  const conflictingSourceUrls = new Set<string>();

  for (const citation of citations) {
    const tokens = extractComparableTokens(citation.snippet);

    if (tokens.length === 0) {
      continue;
    }

    if (tokens.some((token) => expectedTokens.includes(token))) {
      matchingSourceUrls.add(citation.sourceUrl);
      conflictingSourceUrls.delete(citation.sourceUrl);
      continue;
    }

    if (!matchingSourceUrls.has(citation.sourceUrl)) {
      conflictingSourceUrls.add(citation.sourceUrl);
    }
  }

  const comparedSourceCount = matchingSourceUrls.size + conflictingSourceUrls.size;

  return {
    matchingSourceUrls: Array.from(matchingSourceUrls).sort((left, right) => left.localeCompare(right)),
    conflictingSourceUrls: Array.from(conflictingSourceUrls).sort((left, right) => left.localeCompare(right)),
    agreementRatio: comparedSourceCount > 0 ? matchingSourceUrls.size / comparedSourceCount : 1,
    unresolvedDirectContradiction: matchingSourceUrls.size > 0 && conflictingSourceUrls.size > 0,
  };
}
