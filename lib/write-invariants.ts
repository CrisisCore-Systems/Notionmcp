import type { PersistedWriteAuditRecord } from "@/lib/write-audit-store";
import type { WriteExecutionSuccess } from "@/lib/write-execution";
import type { RowWriteAuditEntry, WriteAuditTrail } from "@/lib/write-audit";

type WriteAuditRecordInvariantInput = Pick<
  PersistedWriteAuditRecord,
  | "databaseId"
  | "status"
  | "usedExistingDatabase"
  | "resumedFromIndex"
  | "nextRowIndex"
  | "providerMode"
  | "message"
  | "auditTrail"
>;

const WRITTEN_STATUSES = new Set<RowWriteAuditEntry["status"]>(["written", "written-after-reconciliation"]);

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function hasText(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function hasSubstantiveEvidenceSummary(value: string | undefined): boolean {
  return hasText(value) && value?.trim().toLowerCase() !== "evidence summary unavailable";
}

export function validateWriteAuditTrailInvariants(auditTrail: WriteAuditTrail): string[] {
  const errors: string[] = [];
  const computed = {
    rowsConfirmedWritten: 0,
    rowsConfirmedAfterReconciliation: 0,
    rowsSkippedAsDuplicates: 0,
    rowsLeftUnresolved: 0,
  };

  if (!isNonNegativeInteger(auditTrail.rowsReviewed)) {
    errors.push("rowsReviewed must be a non-negative integer.");
  }

  if (!isNonNegativeInteger(auditTrail.rowsAttempted)) {
    errors.push("rowsAttempted must be a non-negative integer.");
  }

  for (const row of auditTrail.rows) {
    if (!isNonNegativeInteger(row.rowIndex)) {
      errors.push(`Row ${row.rowIndex} must use a non-negative integer rowIndex.`);
      continue;
    }

    switch (row.status) {
      case "written":
        computed.rowsConfirmedWritten += 1;
        break;
      case "written-after-reconciliation":
        computed.rowsConfirmedWritten += 1;
        computed.rowsConfirmedAfterReconciliation += 1;
        break;
      case "duplicate":
        computed.rowsSkippedAsDuplicates += 1;
        break;
      case "unresolved":
        computed.rowsLeftUnresolved += 1;
        break;
    }

    if (WRITTEN_STATUSES.has(row.status) && !hasText(row.operationKey)) {
      errors.push(`Row ${row.rowIndex} is marked ${row.status} without an operation key.`);
    }

    if (WRITTEN_STATUSES.has(row.status) && !hasSubstantiveEvidenceSummary(row.evidenceSummary)) {
      errors.push(`Row ${row.rowIndex} is marked ${row.status} without an evidence summary.`);
    }
  }

  if (auditTrail.rows.length > auditTrail.rowsReviewed) {
    errors.push("rows cannot exceed rowsReviewed.");
  }

  if (auditTrail.rowsAttempted > auditTrail.rows.length) {
    errors.push("rowsAttempted cannot exceed the number of tracked row outcomes.");
  }

  if (auditTrail.rowsConfirmedWritten !== computed.rowsConfirmedWritten) {
    errors.push("rowsConfirmedWritten does not match the tracked row outcomes.");
  }

  if (auditTrail.rowsConfirmedAfterReconciliation !== computed.rowsConfirmedAfterReconciliation) {
    errors.push("rowsConfirmedAfterReconciliation does not match the tracked row outcomes.");
  }

  if (auditTrail.rowsSkippedAsDuplicates !== computed.rowsSkippedAsDuplicates) {
    errors.push("rowsSkippedAsDuplicates does not match the tracked row outcomes.");
  }

  if (auditTrail.rowsLeftUnresolved !== computed.rowsLeftUnresolved) {
    errors.push("rowsLeftUnresolved does not match the tracked row outcomes.");
  }

  if (
    auditTrail.rowsConfirmedWritten + auditTrail.rowsSkippedAsDuplicates + auditTrail.rowsLeftUnresolved !==
    auditTrail.rows.length
  ) {
    errors.push("Tracked row counts must partition the persisted row outcomes exactly.");
  }

  if (auditTrail.rowsConfirmedAfterReconciliation > auditTrail.rowsConfirmedWritten) {
    errors.push("rowsConfirmedAfterReconciliation cannot exceed rowsConfirmedWritten.");
  }

  return errors;
}

export function assertWriteAuditTrailInvariants(auditTrail: WriteAuditTrail): WriteAuditTrail {
  const errors = validateWriteAuditTrailInvariants(auditTrail);

  if (errors.length > 0) {
    throw new Error(`Write audit invariant violation: ${errors.join(" ")}`);
  }

  return auditTrail;
}

export function assertPersistedWriteAuditRecordInvariants(
  record: WriteAuditRecordInvariantInput,
  previousRecord?: Pick<PersistedWriteAuditRecord, "resumedFromIndex" | "nextRowIndex">
): WriteAuditRecordInvariantInput {
  const errors = validateWriteAuditTrailInvariants(record.auditTrail);

  if (!isNonNegativeInteger(record.resumedFromIndex)) {
    errors.push("resumedFromIndex must be a non-negative integer.");
  }

  if (previousRecord && record.resumedFromIndex !== previousRecord.resumedFromIndex) {
    errors.push("resumedFromIndex cannot move backward or change once the write audit is created.");
  }

  if (record.nextRowIndex !== undefined) {
    if (!isNonNegativeInteger(record.nextRowIndex)) {
      errors.push("nextRowIndex must be a non-negative integer when present.");
    } else {
      if (record.nextRowIndex < record.resumedFromIndex) {
        errors.push("nextRowIndex cannot move backward before resumedFromIndex.");
      }

      if (record.nextRowIndex > record.auditTrail.rowsReviewed) {
        errors.push("nextRowIndex cannot exceed rowsReviewed.");
      }

      if (previousRecord?.nextRowIndex !== undefined && record.nextRowIndex < previousRecord.nextRowIndex) {
        errors.push("nextRowIndex must be monotonic across persisted audit updates.");
      }
    }
  }

  if (record.status !== "running" && !hasText(record.providerMode)) {
    errors.push("providerMode must be captured on terminal write audits.");
  }

  if (record.status === "complete") {
    if (record.auditTrail.rowsLeftUnresolved !== 0) {
      errors.push("Completed write audits cannot report unresolved rows.");
    }

    if (record.auditTrail.rows.some((row) => row.status === "unresolved")) {
      errors.push("Completed write audits cannot contain unresolved row outcomes.");
    }
  }

  if (errors.length > 0) {
    throw new Error(`Write audit invariant violation: ${errors.join(" ")}`);
  }

  return record;
}

export function assertWriteExecutionSuccessInvariants(
  success: WriteExecutionSuccess,
  persistedAudit: PersistedWriteAuditRecord
): WriteExecutionSuccess {
  const errors: string[] = [];

  if (persistedAudit.status !== "complete") {
    errors.push("Successful writes require a complete persisted audit.");
  }

  if (success.auditId !== persistedAudit.id) {
    errors.push("Successful writes must return the persisted audit ID.");
  }

  if (success.providerMode !== persistedAudit.providerMode) {
    errors.push("Successful writes must return the persisted provider mode.");
  }

  if (success.itemsWritten !== persistedAudit.auditTrail.rowsConfirmedWritten) {
    errors.push("Successful writes must return rowsConfirmedWritten.");
  }

  if (success.itemsSkipped !== persistedAudit.auditTrail.rowsSkippedAsDuplicates) {
    errors.push("Successful writes must return rowsSkippedAsDuplicates.");
  }

  if (success.resumedFromIndex !== persistedAudit.resumedFromIndex) {
    errors.push("Successful writes must return the persisted resumedFromIndex.");
  }

  if (success.auditTrail.rowsLeftUnresolved !== 0) {
    errors.push("Successful writes cannot expose unresolved rows in the returned audit trail.");
  }

  if (errors.length > 0) {
    throw new Error(`Write execution invariant violation: ${errors.join(" ")}`);
  }

  return success;
}
