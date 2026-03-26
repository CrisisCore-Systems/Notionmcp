import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { incrementMetric, infoLog } from "@/lib/observability";

const DEFAULT_RETENTION_DAYS = 30;
const ENCRYPTED_STATE_FORMAT = "notionmcp-encrypted-state/v1";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_DERIVATION = "pbkdf2-sha256";
const LEGACY_ENCRYPTION_KEY_DERIVATION = "sha256";
const ENCRYPTION_KEY_LENGTH_BYTES = 32;
const ENCRYPTION_KEY_DERIVATION_ITERATIONS = 210_000;
const ENCRYPTION_KEY_DERIVATION_SALT_BYTES = 16;

type EncryptedStateEnvelope = {
  format: typeof ENCRYPTED_STATE_FORMAT;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
   kdf?: typeof ENCRYPTION_KEY_DERIVATION | typeof LEGACY_ENCRYPTION_KEY_DERIVATION;
   salt?: string;
   iterations?: number;
};

function hasConfiguredValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function getPersistenceSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.PERSISTED_STATE_ENCRYPTION_KEY?.trim();
  return configured ? configured : null;
}

export function isRemotePrivateMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasConfiguredValue(env.APP_ALLOWED_ORIGIN) && hasConfiguredValue(env.APP_ACCESS_TOKEN);
}

export function getPersistedStateEncryptionRequirementError(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!isRemotePrivateMode(env) || getPersistenceSecret(env)) {
    return null;
  }

  return (
    "Remote private deployments must set PERSISTED_STATE_ENCRYPTION_KEY so persisted durable-job " +
    "state, write-audit state, and remote request-coordination state are encrypted at rest."
  );
}

export function assertPersistedStateEncryptionRequirement(
  env: NodeJS.ProcessEnv = process.env
): void {
  const error = getPersistedStateEncryptionRequirementError(env);

  if (error) {
    throw new Error(error);
  }
}

function deriveEncryptionKey(secret: string, salt: Buffer, iterations = ENCRYPTION_KEY_DERIVATION_ITERATIONS): Buffer {
  return pbkdf2Sync(secret, salt, iterations, ENCRYPTION_KEY_LENGTH_BYTES, "sha256");
}

function deriveLegacyEncryptionKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function deriveEncryptionKeyForEnvelope(envelope: EncryptedStateEnvelope, secret: string): Buffer {
  if (!envelope.kdf || envelope.kdf === LEGACY_ENCRYPTION_KEY_DERIVATION) {
    return deriveLegacyEncryptionKey(secret);
  }

  if (envelope.kdf !== ENCRYPTION_KEY_DERIVATION || !envelope.salt) {
    throw new Error("Unsupported persisted-state encryption key derivation function.");
  }

  const iterations =
    Number.isSafeInteger(envelope.iterations) && (envelope.iterations ?? 0) > 0
      ? envelope.iterations
      : ENCRYPTION_KEY_DERIVATION_ITERATIONS;
  return deriveEncryptionKey(secret, Buffer.from(envelope.salt, "base64"), iterations);
}

function isEncryptedStateEnvelope(value: unknown): value is EncryptedStateEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.format === ENCRYPTED_STATE_FORMAT &&
    candidate.algorithm === ENCRYPTION_ALGORITHM &&
    typeof candidate.iv === "string" &&
    typeof candidate.tag === "string" &&
    typeof candidate.ciphertext === "string"
  );
}

function encryptState(record: unknown, secret: string): string {
  const iv = randomBytes(12);
  const salt = randomBytes(ENCRYPTION_KEY_DERIVATION_SALT_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, deriveEncryptionKey(secret, salt), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(record), "utf8"),
    cipher.final(),
  ]);
  const envelope: EncryptedStateEnvelope = {
    format: ENCRYPTED_STATE_FORMAT,
    algorithm: ENCRYPTION_ALGORITHM,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    kdf: ENCRYPTION_KEY_DERIVATION,
    salt: salt.toString("base64"),
    iterations: ENCRYPTION_KEY_DERIVATION_ITERATIONS,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function decryptState(envelope: EncryptedStateEnvelope, secret: string): unknown {
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    deriveEncryptionKeyForEnvelope(envelope, secret),
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as unknown;
}

export function getPersistedStateRetentionDays(
  envVarName: string,
  env: NodeJS.ProcessEnv = process.env
): number {
  const configured = env[envVarName]?.trim();

  if (!configured) {
    return DEFAULT_RETENTION_DAYS;
  }

  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

export async function cleanupExpiredPersistedStateFiles(
  directory: string,
  envVarName: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const retentionDays = getPersistedStateRetentionDays(envVarName, env);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  try {
    const entries = await readdir(directory, { withFileTypes: true });
    let deletedFiles = 0;

    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && path.extname(entry.name) === ".json")
        .map(async (entry) => {
          const filePath = path.join(directory, entry.name);
          const details = await stat(filePath);

          if (details.mtimeMs < cutoffMs) {
            await unlink(filePath);
            deletedFiles += 1;
          }
        })
    );
    incrementMetric("backgroundCleanupRuns");
    incrementMetric("backgroundCleanupFilesDeleted", deletedFiles);

    if (deletedFiles > 0) {
      infoLog("persisted-state", "Removed expired persisted-state files.", {
        directory,
        deletedFiles,
        retentionDays,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function writePersistedStateFile(
  filePath: string,
  record: unknown,
  envVarName: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  assertPersistedStateEncryptionRequirement(env);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  await cleanupExpiredPersistedStateFiles(directory, envVarName, env);
  const secret = getPersistenceSecret(env);
  const serialized = secret
    ? encryptState(record, secret)
    : `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(filePath, serialized, "utf8");
}

export async function readPersistedStateFile<T>(
  filePath: string,
  envVarName: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<T> {
  assertPersistedStateEncryptionRequirement(env);
  await cleanupExpiredPersistedStateFiles(path.dirname(filePath), envVarName, env);
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!isEncryptedStateEnvelope(parsed)) {
    return parsed as T;
  }

  const secret = getPersistenceSecret(env);

  if (!secret) {
    throw new Error(
      "Found encrypted persisted state but PERSISTED_STATE_ENCRYPTION_KEY is not configured. Set this environment variable to decrypt the state."
    );
  }

  return decryptState(parsed, secret) as T;
}
