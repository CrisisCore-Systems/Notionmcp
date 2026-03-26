import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ENCRYPTION_KEY_DERIVATION_ITERATIONS,
  readPersistedStateFile,
  writePersistedStateFile,
} from "@/lib/persisted-state";

test("writePersistedStateFile uses PBKDF2 metadata for newly encrypted state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notionmcp-persisted-state-"));
  const filePath = path.join(directory, "state.json");
  const env = {
    NODE_ENV: "test",
    PERSISTED_STATE_ENCRYPTION_KEY: "operator-secret",
  } as NodeJS.ProcessEnv;

  try {
    await writePersistedStateFile(filePath, { message: "encrypted" }, "JOB_STATE_RETENTION_DAYS", env);

    const rawFile = await readFile(filePath, "utf8");
    const parsed = JSON.parse(rawFile) as {
      kdf?: string;
      salt?: string;
      iterations?: number;
    };

    assert.equal(parsed.kdf, "pbkdf2-sha256");
    assert.equal(typeof parsed.salt, "string");
    assert.equal(parsed.iterations, ENCRYPTION_KEY_DERIVATION_ITERATIONS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readPersistedStateFile still decrypts legacy SHA-256-derived envelopes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notionmcp-persisted-state-"));
  const filePath = path.join(directory, "legacy.json");
  const secret = "operator-secret";
  const env = {
    NODE_ENV: "test",
    PERSISTED_STATE_ENCRYPTION_KEY: secret,
  } as NodeJS.ProcessEnv;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret, "utf8").digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ message: "legacy" }), "utf8"), cipher.final()]);

  try {
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          format: "notionmcp-encrypted-state/v1",
          algorithm: "aes-256-gcm",
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const loaded = await readPersistedStateFile<{ message: string }>(filePath, "JOB_STATE_RETENTION_DAYS", env);

    assert.equal(loaded.message, "legacy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readPersistedStateFile rejects weakened PBKDF2 iteration metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notionmcp-persisted-state-"));
  const filePath = path.join(directory, "tampered.json");
  const env = {
    NODE_ENV: "test",
    PERSISTED_STATE_ENCRYPTION_KEY: "operator-secret",
  } as NodeJS.ProcessEnv;

  try {
    await writePersistedStateFile(filePath, { message: "encrypted" }, "JOB_STATE_RETENTION_DAYS", env);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
      iterations?: number;
    };
    parsed.iterations = 1;
    await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    await assert.rejects(
      readPersistedStateFile(filePath, "JOB_STATE_RETENTION_DAYS", env),
      /Invalid persisted-state PBKDF2 iteration count/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
