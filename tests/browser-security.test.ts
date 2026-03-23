import assert from "node:assert/strict";
import test from "node:test";
import { validatePublicHttpUrl } from "@/lib/browser";

test("validatePublicHttpUrl blocks localhost URLs before any browse happens", async () => {
  await assert.rejects(
    () => validatePublicHttpUrl("http://localhost:3000/internal"),
    /Local, private, and link-local addresses are blocked/
  );
});

test("validatePublicHttpUrl blocks credentialed URLs", async () => {
  await assert.rejects(
    () => validatePublicHttpUrl("https://user:pass@example.com/secret"),
    /Credentialed URLs are not allowed/
  );
});

test("validatePublicHttpUrl blocks private IP targets", async () => {
  await assert.rejects(
    () => validatePublicHttpUrl("http://127.0.0.1/admin"),
    /Local, private, and link-local addresses are blocked/
  );
});

test("validatePublicHttpUrl blocks non-http protocols", async () => {
  await assert.rejects(
    () => validatePublicHttpUrl("file:///etc/passwd"),
    /Only public http\(s\) URLs can be browsed/
  );
});
