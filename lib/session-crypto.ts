import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const SESSION_ENVELOPE_FORMAT = "notionmcp-session/v1";
const SESSION_ALGORITHM = "aes-256-gcm";

type SessionEnvelope = {
  format: typeof SESSION_ENVELOPE_FORMAT;
  iv: string;
  tag: string;
  ciphertext: string;
};

function getSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured =
    env.PERSISTED_STATE_ENCRYPTION_KEY?.trim() ||
    env.NOTION_CLIENT_SECRET?.trim() ||
    env.APP_ACCESS_TOKEN?.trim();

  if (!configured) {
    throw new Error(
      "A session encryption secret is required. Configure PERSISTED_STATE_ENCRYPTION_KEY, NOTION_CLIENT_SECRET, or APP_ACCESS_TOKEN."
    );
  }

  return configured;
}

function deriveSessionKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function isSessionEnvelope(value: unknown): value is SessionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.format === SESSION_ENVELOPE_FORMAT &&
    typeof candidate.iv === "string" &&
    typeof candidate.tag === "string" &&
    typeof candidate.ciphertext === "string"
  );
}

export function encryptSessionValue(value: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(SESSION_ALGORITHM, deriveSessionKey(getSessionSecret(env)), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);

  const envelope: SessionEnvelope = {
    format: SESSION_ENVELOPE_FORMAT,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };

  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function decryptSessionValue<T>(
  serialized: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): T | null {
  const trimmed = serialized?.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8")) as unknown;

    if (!isSessionEnvelope(parsed)) {
      return null;
    }

    const decipher = createDecipheriv(
      SESSION_ALGORITHM,
      deriveSessionKey(getSessionSecret(env)),
      Buffer.from(parsed.iv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");

    return JSON.parse(plaintext) as T;
  } catch {
    return null;
  }
}