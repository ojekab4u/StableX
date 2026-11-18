import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyBridgeSignature, BRIDGE_WEBHOOK_MAX_AGE_MS } from "../services/bridgeWebhookService.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Mirrors Bridge's scheme: sign SHA256("<t>.<body>") as the message.
const sign = (body, ts) => {
  const digest = crypto.createHash("sha256").update(`${ts}.${body}`).digest();
  return `t=${ts},v0=${crypto.sign("sha256", digest, privateKey).toString("base64")}`;
};

const body = JSON.stringify({ event_category: "virtual_account.activity", event_id: "wh_test_1" });
const now = Date.now();

test("accepts a correctly signed, fresh delivery", () => {
  const result = verifyBridgeSignature({ rawBody: body, header: sign(body, now), publicKeyPem: publicKey, nowMs: now });
  assert.equal(result.ok, true);
});

test("rejects a tampered body", () => {
  const header = sign(body, now);
  const result = verifyBridgeSignature({ rawBody: body.replace("wh_test_1", "wh_forged"), header, publicKeyPem: publicKey, nowMs: now });
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("rejects a delivery older than the replay window", () => {
  const old = now - BRIDGE_WEBHOOK_MAX_AGE_MS - 1000;
  const result = verifyBridgeSignature({ rawBody: body, header: sign(body, old), publicKeyPem: publicKey, nowMs: now });
  assert.deepEqual(result, { ok: false, reason: "stale_timestamp" });
});

test("rejects a missing signature header", () => {
  const result = verifyBridgeSignature({ rawBody: body, header: undefined, publicKeyPem: publicKey, nowMs: now });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_signature_parts");
});
