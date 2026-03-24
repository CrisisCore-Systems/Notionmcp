import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_RETENTION_DAYS = 30;
const ENCRYPTED_STATE_FORMAT = "notionmcp-encrypted-state/v1";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";

type EncryptedStateEnvelope = {
  format: typeof ENCRYPTED_STATE_FORMAT;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
};

function getPersistenceSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.PERSISTED_STATE_ENCRYPTION_KEY?.trim();
  return configured ? configured : null;
}

function deriveEncryptionKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
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
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, deriveEncryptionKey(secret), iv);
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
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function decryptState(envelope: EncryptedStateEnvelope, secret: string): unknown {
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    deriveEncryptionKey(secret),
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

    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && path.extname(entry.name) === ".json")
        .map(async (entry) => {
          const filePath = path.join(directory, entry.name);
          const details = await stat(filePath);

          if (details.mtimeMs < cutoffMs) {
            await unlink(filePath);
          }
        })
    );
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
