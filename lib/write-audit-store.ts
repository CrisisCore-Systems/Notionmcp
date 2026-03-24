import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WriteAuditTrail } from "@/lib/write-audit";

const WRITE_AUDIT_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

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

  await mkdir(getWriteAuditDirectory(), { recursive: true });
  await writeFile(getWriteAuditPath(persistedRecord.id), `${JSON.stringify(persistedRecord, null, 2)}\n`, "utf8");
  return persistedRecord;
}

export async function loadWriteAuditRecord(auditId: string): Promise<PersistedWriteAuditRecord | null> {
  const trimmedAuditId = auditId.trim();

  if (!isValidWriteAuditId(trimmedAuditId)) {
    return null;
  }

  try {
    const rawRecord = await readFile(getWriteAuditPath(trimmedAuditId), "utf8");
    const parsed = JSON.parse(rawRecord) as unknown;
    return isPersistedWriteAuditRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
