import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WriteAuditTrail } from "@/lib/write-audit";
import { readPersistedStateFile, writePersistedStateFile } from "@/lib/persisted-state";

const WRITE_AUDIT_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;
const WRITE_AUDIT_RETENTION_ENV_VAR = "WRITE_AUDIT_RETENTION_DAYS";

export type PersistedWriteAuditRecord = {
  id: string;
  createdAt: string;
  databaseId?: string;
  status: "running" | "complete" | "error";
  usedExistingDatabase: boolean;
  resumedFromIndex: number;
  nextRowIndex?: number;
  providerMode?: string;
  message: string;
  auditTrail: WriteAuditTrail;
};

function isPersistedWriteAuditRecord(value: unknown): value is PersistedWriteAuditRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.usedExistingDatabase === "boolean" &&
    typeof candidate.resumedFromIndex === "number" &&
    typeof candidate.message === "string" &&
    !!candidate.auditTrail &&
    typeof candidate.auditTrail === "object"
  );
}

export function getWriteAuditDirectory(): string {
  const configured = process.env.WRITE_AUDIT_DIR?.trim();
  return configured || path.join(process.cwd(), ".notionmcp-data", "write-audits");
}

export function isValidWriteAuditId(auditId: string): boolean {
  return WRITE_AUDIT_ID_PATTERN.test(auditId.trim());
}

function getWriteAuditPath(auditId: string): string {
  if (!isValidWriteAuditId(auditId)) {
    throw new Error("Invalid write audit ID");
  }

  return path.join(getWriteAuditDirectory(), `${auditId.trim()}.json`);
}

export function buildWriteAuditUrl(auditId: string): string {
  return `/api/write-audits/${encodeURIComponent(auditId)}`;
}

export async function persistWriteAuditRecord(
  record: Omit<PersistedWriteAuditRecord, "id" | "createdAt">
): Promise<PersistedWriteAuditRecord> {
  const persistedRecord: PersistedWriteAuditRecord = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...record,
  };

  await writePersistedStateFile(
    getWriteAuditPath(persistedRecord.id),
    persistedRecord,
    WRITE_AUDIT_RETENTION_ENV_VAR
  );
  return persistedRecord;
}

export async function loadWriteAuditRecord(auditId: string): Promise<PersistedWriteAuditRecord | null> {
  const trimmedAuditId = auditId.trim();

  if (!isValidWriteAuditId(trimmedAuditId)) {
    return null;
  }

  try {
    const parsed = await readPersistedStateFile<unknown>(
      getWriteAuditPath(trimmedAuditId),
      WRITE_AUDIT_RETENTION_ENV_VAR
    );
    return isPersistedWriteAuditRecord(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
