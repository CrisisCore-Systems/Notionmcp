import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const ARTIFACT_INTEGRITY_ALGORITHM = "hmac-sha256";
const LOCAL_INTEGRITY_KEY_FILE = ".artifact-integrity.key";

export type ArtifactIntegrityMetadata = {
  algorithm: typeof ARTIFACT_INTEGRITY_ALGORITHM;
  recordHash: string;
  previousHash?: string;
  mac: string;
  keyId: string;
  signedAt: string;
};

type IntegrityKeyMaterial = {
  secret: string;
  keyId: string;
};

type VerifyArtifactIntegrityResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    };

function normalizeForSigning(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForSigning(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForSigning((value as Record<string, unknown>)[key])])
    );
  }

  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForSigning(value));
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function buildKeyId(secret: string): string {
  return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16)}`;
}

async function getLocalIntegritySecret(directory: string): Promise<string> {
  const secretPath = path.join(directory, LOCAL_INTEGRITY_KEY_FILE);

  try {
    return (await readFile(secretPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(directory, { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  await writeFile(secretPath, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  return secret;
}

async function resolveIntegrityKey(filePath: string, env: NodeJS.ProcessEnv): Promise<IntegrityKeyMaterial> {
  const configuredSecret =
    env.ARTIFACT_INTEGRITY_SECRET?.trim() || env.PERSISTED_STATE_ENCRYPTION_KEY?.trim();
  const secret = configuredSecret || (await getLocalIntegritySecret(path.dirname(filePath)));

  return {
    secret,
    keyId: buildKeyId(secret),
  };
}

function buildMacPayload(
  scope: string,
  keyId: string,
  signedAt: string,
  recordHash: string,
  previousHash: string | undefined,
  metadata: Record<string, unknown>
): string {
  return stableStringify({
    scope,
    keyId,
    signedAt,
    recordHash,
    previousHash: previousHash ?? null,
    metadata,
  });
}

function computeMac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export async function signArtifactIntegrity<TMetadata extends Record<string, unknown>>(
  filePath: string,
  scope: string,
  payload: unknown,
  metadata: TMetadata,
  previousHash?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ArtifactIntegrityMetadata & TMetadata> {
  const { secret, keyId } = await resolveIntegrityKey(filePath, env);
  const recordHash = sha256Hex(payload);
  const signedAt = new Date().toISOString();
  const mac = computeMac(
    secret,
    buildMacPayload(scope, keyId, signedAt, recordHash, previousHash, metadata)
  );

  return {
    algorithm: ARTIFACT_INTEGRITY_ALGORITHM,
    recordHash,
    ...(previousHash ? { previousHash } : {}),
    mac,
    keyId,
    signedAt,
    ...metadata,
  };
}

export async function verifyArtifactIntegrity<TMetadata extends Record<string, unknown>>(
  filePath: string,
  scope: string,
  payload: unknown,
  metadata: TMetadata,
  integrity: ArtifactIntegrityMetadata | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<VerifyArtifactIntegrityResult> {
  if (!integrity) {
    return {
      ok: false,
      reason: "missing integrity metadata",
    };
  }

  if (
    integrity.algorithm !== ARTIFACT_INTEGRITY_ALGORITHM ||
    !integrity.recordHash ||
    !integrity.mac ||
    !integrity.keyId ||
    !integrity.signedAt
  ) {
    return {
      ok: false,
      reason: "incomplete integrity metadata",
    };
  }

  const expectedRecordHash = sha256Hex(payload);

  if (integrity.recordHash !== expectedRecordHash) {
    return {
      ok: false,
      reason: "record hash mismatch",
    };
  }

  const { secret, keyId } = await resolveIntegrityKey(filePath, env);

  if (integrity.keyId !== keyId) {
    return {
      ok: false,
      reason: "integrity key mismatch",
    };
  }

  const expectedMac = computeMac(
    secret,
    buildMacPayload(
      scope,
      integrity.keyId,
      integrity.signedAt,
      integrity.recordHash,
      integrity.previousHash,
      metadata
    )
  );
  const actualBuffer = Buffer.from(integrity.mac, "hex");
  const expectedBuffer = Buffer.from(expectedMac, "hex");

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return {
      ok: false,
      reason: "artifact MAC mismatch",
    };
  }

  return { ok: true };
}

export function createEventIntegrity<TEvent extends Record<string, unknown>>(
  event: TEvent,
  previousEventHash?: string
): TEvent & { eventHash: string; previousEventHash?: string } {
  const eventHash = sha256Hex({
    ...event,
    previousEventHash: previousEventHash ?? null,
  });

  return {
    ...event,
    ...(previousEventHash ? { previousEventHash } : {}),
    eventHash,
  };
}

export function verifyChainedEvents<TEvent extends { eventHash?: string; previousEventHash?: string }>(
  events: TEvent[]
): VerifyArtifactIntegrityResult {
  let previousEventHash: string | undefined;

  for (const event of events) {
    if (!event.eventHash) {
      return {
        ok: false,
        reason: "missing event hash",
      };
    }

    if ((event.previousEventHash ?? undefined) !== previousEventHash) {
      return {
        ok: false,
        reason: "event chain linkage mismatch",
      };
    }

    const { eventHash, ...unsignedEvent } = event;
    const expectedEventHash = sha256Hex({
      ...unsignedEvent,
      previousEventHash: previousEventHash ?? null,
    });

    if (eventHash !== expectedEventHash) {
      return {
        ok: false,
        reason: "event hash mismatch",
      };
    }

    previousEventHash = eventHash;
  }

  return { ok: true };
}
