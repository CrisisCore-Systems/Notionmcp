import type { NotionSchema } from "@/lib/notion/provider";
import { sanitizeEvidenceText } from "@/lib/evidence-reduction";
import {
  NOTION_PROPERTY_TYPES,
  enforceNotionValueLimit,
  getResearchItemValidationIssues,
  isValidHttpUrl,
  normalizeNumberValue,
  normalizeTextValue,
} from "@/lib/notion-validation";
import {
  RESEARCH_ITEM_PROVENANCE_KEY,
  RESEARCH_RUN_METADATA_KEY,
  type ResearchItem,
  type ResearchNotionQueueMetadata,
  type ResearchItemProvenance,
  type ResearchRunMetadata,
  type ResearchResult,
} from "@/lib/research-result";

function getUniquePropertyName(requestedName: string, existingNames: Set<string>): string {
  const baseName = requestedName.trim().replace(/\s+/g, " ") || "Field";
  let candidate = baseName;
  let suffix = 2;

  while (existingNames.has(candidate.toLowerCase())) {
    candidate = `${baseName} ${suffix}`;
    suffix += 1;
  }

  existingNames.add(candidate.toLowerCase());
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSourceUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();

  return value
    .map((entry) => normalizeTextValue(entry))
    .filter((entry) => {
      if (!entry || !isValidHttpUrl(entry) || seen.has(entry)) {
        return false;
      }

      seen.add(entry);
      return true;
    });
}

function normalizeEvidenceByField(
  value: unknown,
  normalizedKeyLookup?: Map<string, string>
): Record<string, string[]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(value)
      .map(([fieldName, fieldEvidence]) => [
        normalizedKeyLookup?.get(fieldName) ?? normalizeTextValue(fieldName),
        Array.isArray(fieldEvidence)
          ? fieldEvidence
              .flatMap((entry) =>
                sanitizeEvidenceText(normalizeTextValue(entry))
                  .split("\n")
                  .map((snippet) => snippet.trim())
                  .filter(Boolean)
              )
              .filter(Boolean)
              .slice(0, 5)
          : [],
      ])
      .filter(([fieldName, fieldEvidence]) => fieldName && fieldEvidence.length > 0)
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeProvenanceForSchema(
  value: unknown,
  normalizedKeyLookup: Map<string, string>
): ResearchItemProvenance | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sourceUrls = normalizeSourceUrls(value.sourceUrls);
  const evidenceByField = normalizeEvidenceByField(value.evidenceByField, normalizedKeyLookup);

  if (sourceUrls.length === 0 && !evidenceByField) {
    return undefined;
  }

  return {
    ...(sourceUrls.length > 0 ? { sourceUrls } : { sourceUrls: [] }),
    ...(evidenceByField ? { evidenceByField } : {}),
  };
}

function normalizeResearchRunMetadata(value: unknown): ResearchRunMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sourceSet = normalizeSourceUrls(value.sourceSet);
  const rejectedUrls = normalizeSourceUrls(value.rejectedUrls);
  const extractionCounts = isRecord(value.extractionCounts) ? value.extractionCounts : {};
  const searchQueries =
    typeof extractionCounts.searchQueries === "number" && extractionCounts.searchQueries >= 0
      ? Math.floor(extractionCounts.searchQueries)
      : 0;
  const candidateSources =
    typeof extractionCounts.candidateSources === "number" && extractionCounts.candidateSources >= 0
      ? Math.floor(extractionCounts.candidateSources)
      : sourceSet.length;
  const pagesBrowsed =
    typeof extractionCounts.pagesBrowsed === "number" && extractionCounts.pagesBrowsed >= 0
      ? Math.floor(extractionCounts.pagesBrowsed)
      : sourceSet.length;
  const rowsExtracted =
    typeof extractionCounts.rowsExtracted === "number" && extractionCounts.rowsExtracted >= 0
      ? Math.floor(extractionCounts.rowsExtracted)
      : 0;
  const search = isRecord(value.search) ? value.search : undefined;
  const normalizedMode =
    search?.mode === "fast" || search?.mode === "deep" ? (search.mode as "fast" | "deep") : undefined;
  const normalizedSearch =
    search &&
    Array.isArray(search.configuredProviders) &&
    Array.isArray(search.usedProviders)
      ? {
          configuredProviders: search.configuredProviders.filter(
            (provider): provider is string => typeof provider === "string" && Boolean(provider.trim())
          ),
          usedProviders: search.usedProviders.filter(
            (provider): provider is string => typeof provider === "string" && Boolean(provider.trim())
          ),
          degraded: Boolean(search.degraded),
          ...(normalizedMode ? { mode: normalizedMode } : {}),
          ...(isRecord(search.profile)
            ? {
                profile: {
                  maxPlannedQueries:
                    typeof search.profile.maxPlannedQueries === "number" && search.profile.maxPlannedQueries >= 0
                      ? Math.floor(search.profile.maxPlannedQueries)
                      : searchQueries,
                  maxEvidenceDocuments:
                    typeof search.profile.maxEvidenceDocuments === "number" &&
                    search.profile.maxEvidenceDocuments >= 0
                      ? Math.floor(search.profile.maxEvidenceDocuments)
                      : candidateSources,
                  minUniqueDomains:
                    typeof search.profile.minUniqueDomains === "number" && search.profile.minUniqueDomains >= 0
                      ? Math.floor(search.profile.minUniqueDomains)
                      : 0,
                  minSourceClasses:
                    typeof search.profile.minSourceClasses === "number" && search.profile.minSourceClasses >= 0
                      ? Math.floor(search.profile.minSourceClasses)
                      : 0,
                  ...(typeof search.profile.plannerModel === "string" && search.profile.plannerModel.trim()
                    ? { plannerModel: search.profile.plannerModel.trim() }
                    : {}),
                  ...(typeof search.profile.verifierModel === "string" && search.profile.verifierModel.trim()
                    ? { verifierModel: search.profile.verifierModel.trim() }
                    : {}),
                  ...(typeof search.profile.maxReconciliationAttempts === "number" &&
                  search.profile.maxReconciliationAttempts >= 0
                    ? { maxReconciliationAttempts: Math.floor(search.profile.maxReconciliationAttempts) }
                    : {}),
                  ...(typeof search.profile.minIndependentSourcesPerField === "number" &&
                  search.profile.minIndependentSourcesPerField >= 0
                    ? { minIndependentSourcesPerField: Math.floor(search.profile.minIndependentSourcesPerField) }
                    : {}),
                  ...(typeof search.profile.minCrossSourceAgreement === "number" &&
                  search.profile.minCrossSourceAgreement >= 0
                    ? { minCrossSourceAgreement: search.profile.minCrossSourceAgreement }
                    : {}),
                },
              }
            : {}),
          ...(Array.isArray(search.uniqueDomains)
            ? {
                uniqueDomains: search.uniqueDomains.filter(
                  (domain): domain is string => typeof domain === "string" && Boolean(domain.trim())
                ),
              }
            : {}),
          ...(Array.isArray(search.sourceClasses)
            ? {
                sourceClasses: search.sourceClasses.filter(
                  (sourceClass): sourceClass is string =>
                    typeof sourceClass === "string" && Boolean(sourceClass.trim())
                ),
              }
            : {}),
          ...(isRecord(search.sourceQuality) &&
          Array.isArray(search.sourceQuality.strongestSourceUrls)
            ? {
                sourceQuality: {
                  averageScore:
                    typeof search.sourceQuality.averageScore === "number" ? search.sourceQuality.averageScore : 0,
                  primarySourceCount:
                    typeof search.sourceQuality.primarySourceCount === "number"
                      ? Math.floor(search.sourceQuality.primarySourceCount)
                      : 0,
                  officialSourceCount:
                    typeof search.sourceQuality.officialSourceCount === "number"
                      ? Math.floor(search.sourceQuality.officialSourceCount)
                      : 0,
                  dateAvailableSourceCount:
                    typeof search.sourceQuality.dateAvailableSourceCount === "number"
                      ? Math.floor(search.sourceQuality.dateAvailableSourceCount)
                      : 0,
                  authorAvailableSourceCount:
                    typeof search.sourceQuality.authorAvailableSourceCount === "number"
                      ? Math.floor(search.sourceQuality.authorAvailableSourceCount)
                      : 0,
                  strongestSourceUrls: normalizeSourceUrls(search.sourceQuality.strongestSourceUrls),
                },
              }
            : {}),
          ...(isRecord(search.freshness) &&
          typeof search.freshness.timeSensitivePrompt === "boolean" &&
          typeof search.freshness.sourceCountWithDates === "number"
            ? {
                freshness: {
                  timeSensitivePrompt: search.freshness.timeSensitivePrompt,
                  sourceCountWithDates: Math.floor(search.freshness.sourceCountWithDates),
                },
              }
            : {}),
       }
      : undefined;
  const notionQueue = normalizeResearchNotionQueueMetadata(value.notionQueue);

  return {
    sourceSet,
    extractionCounts: {
      searchQueries,
      candidateSources,
      pagesBrowsed,
      rowsExtracted,
    },
    rejectedUrls,
    ...(normalizedSearch ? { search: normalizedSearch } : {}),
    ...(notionQueue ? { notionQueue } : {}),
  };
}

function normalizeResearchNotionQueueMetadata(value: unknown): ResearchNotionQueueMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const databaseId = normalizeTextValue(value.databaseId);
  const pageId = normalizeTextValue(value.pageId);
  const title = normalizeTextValue(value.title);
  const statusProperty = normalizeTextValue(value.statusProperty);
  const runId = normalizeTextValue(value.runId);
  const claimedBy = normalizeTextValue(value.claimedBy);

  if (!databaseId || !pageId || !statusProperty || !runId || !claimedBy) {
    return undefined;
  }

  const propertyTypes = isRecord(value.propertyTypes)
    ? Object.fromEntries(
        Object.entries(value.propertyTypes)
          .filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" &&
              typeof entry[1] === "string" &&
              Boolean(entry[0].trim()) &&
              Boolean(entry[1].trim())
          )
          .map(([propertyName, propertyType]) => [propertyName.trim(), propertyType.trim()])
      )
    : undefined;

  return {
    databaseId,
    pageId,
    title,
    statusProperty,
    runId,
    claimedBy,
    ...(propertyTypes && Object.keys(propertyTypes).length > 0 ? { propertyTypes } : {}),
  };
}

function hasAnyPopulatedValue(item: ResearchItem, schema: NotionSchema): boolean {
  return Object.keys(schema).some(
    (key) => typeof item[key] === "string" && item[key].trim().length > 0
  );
}

export { isValidDatabaseId } from "@/lib/notion-validation";

export function normalizeResearchResult(result: ResearchResult): ResearchResult {
  const suggestedDbTitle = result.suggestedDbTitle.trim();
  const summary = result.summary.trim();
  const normalizedSchema: NotionSchema = {};
  const normalizedKeyLookup = new Map<string, string>();
  const seenPropertyNames = new Set<string>();

  for (const [rawName, rawType] of Object.entries(result.schema)) {
    if (!NOTION_PROPERTY_TYPES.includes(rawType)) {
      throw new Error(`Unsupported schema type "${rawType}" for "${rawName}".`);
    }

    const propertyName = getUniquePropertyName(rawName, seenPropertyNames);

    normalizedSchema[propertyName] = rawType;
    normalizedKeyLookup.set(rawName, propertyName);
  }

  const titleFieldCount = Object.values(normalizedSchema).filter((type) => type === "title").length;

  if (!suggestedDbTitle || !summary || titleFieldCount !== 1) {
    throw new Error("A complete research result is required");
  }

  const normalizedItems = result.items
    .map((item, rowIndex) => {
      const normalizedItem: ResearchItem = {};

      for (const [originalKey, normalizedKey] of normalizedKeyLookup.entries()) {
        const propertyType = normalizedSchema[normalizedKey];
        const rawValue = item[originalKey];
        const value = normalizeTextValue(rawValue);

        if (!propertyType) {
          continue;
        }

        if (!value) {
          normalizedItem[normalizedKey] = "";
          continue;
        }

        if (propertyType === "url" && !isValidHttpUrl(value)) {
          throw new Error(
            `Row ${rowIndex + 1} has an invalid URL "${value}" in "${normalizedKey}".`
          );
        }

        if (propertyType === "number") {
          const normalizedNumberValue = normalizeNumberValue(value);

          if (normalizedNumberValue === null) {
            throw new Error(`Row ${rowIndex + 1} has a non-numeric value in "${normalizedKey}".`);
          }

          normalizedItem[normalizedKey] = normalizedNumberValue;
          continue;
        }

        normalizedItem[normalizedKey] = enforceNotionValueLimit(value, propertyType);
      }

      const provenance = normalizeProvenanceForSchema(
        item[RESEARCH_ITEM_PROVENANCE_KEY],
        normalizedKeyLookup
      );

      if (provenance) {
        normalizedItem[RESEARCH_ITEM_PROVENANCE_KEY] = provenance;
      }

      if (hasAnyPopulatedValue(normalizedItem, normalizedSchema)) {
        const validationIssues = getResearchItemValidationIssues(normalizedItem, normalizedSchema, rowIndex);

        if (validationIssues.length > 0) {
          throw new Error(validationIssues[0]?.message ?? "A complete research result is required");
        }
      }

      return normalizedItem;
    })
    .filter((item) =>
      Object.entries(item).some(
        ([key, value]) =>
          key !== RESEARCH_ITEM_PROVENANCE_KEY &&
          typeof value === "string" &&
          value.trim().length > 0
      )
    );

  if (normalizedItems.length === 0) {
    throw new Error("At least one non-empty item is required");
  }

  const runMetadata = normalizeResearchRunMetadata(
    (result as unknown as Record<string, unknown>)[RESEARCH_RUN_METADATA_KEY]
  );

  return {
    suggestedDbTitle,
    summary,
    schema: normalizedSchema,
    items: normalizedItems,
    ...(runMetadata ? { [RESEARCH_RUN_METADATA_KEY]: runMetadata } : {}),
  };
}

export function parseResearchResult(
  value: unknown,
  fallbackMessage = "A complete research result is required"
): ResearchResult {
  if (!isResearchResult(value)) {
    throw new Error(fallbackMessage);
  }

  return normalizeResearchResult(value);
}

export function isResearchResult(value: unknown): value is ResearchResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const schema = candidate.schema;
  const items = candidate.items;

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }

  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    !items.every((item) => item && typeof item === "object" && !Array.isArray(item))
  ) {
    return false;
  }

  return (
    typeof candidate.suggestedDbTitle === "string" &&
      typeof candidate.summary === "string" &&
      Object.values(schema).every(
        (propertyType) =>
          typeof propertyType === "string" &&
          NOTION_PROPERTY_TYPES.includes(propertyType as (typeof NOTION_PROPERTY_TYPES)[number])
      )
  );
}
