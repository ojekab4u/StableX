import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { normalizeVoveOutcome } from "../services/complianceService.js";
import { verifyVoveWebhookSignature } from "../services/voveKybService.js";

test("VOVE KYC COMPLETED is not silently treated as approved", () => {
  assert.deepEqual(
    normalizeVoveOutcome(
      { type: "kyc.case.completed", data: { status: "COMPLETED" } },
      { status: "COMPLETED" },
      { subjectType: "INDIVIDUAL" }
    ),
    { providerStatus: "COMPLETED", status: "IN_REVIEW", statusField: "status" }
  );
});

test("authoritative VOVE KYC SUCCESSFUL result approves even when response omits refId", () => {
  assert.deepEqual(
    normalizeVoveOutcome(
      null,
      { status: "SUCCESSFUL" },
      { subjectType: "INDIVIDUAL" }
    ),
    { providerStatus: "SUCCESSFUL", status: "APPROVED", statusField: "status" }
  );
});

test("nested VOVE verification status is extracted and correlated by the requested refId lookup", () => {
  assert.deepEqual(
    normalizeVoveOutcome(
      null,
      { data: { user: { verificationStatus: "VERIFIED" } } },
      { subjectType: "INDIVIDUAL" }
    ),
    { providerStatus: "VERIFIED", status: "APPROVED", statusField: "data.user.verificationStatus" }
  );
});

test("VOVE KYB COMPLETED is ready for internal review, not automatic approval", () => {
  assert.deepEqual(
    normalizeVoveOutcome(null, { data: { status: "COMPLETED" } }, { subjectType: "BUSINESS" }),
    { providerStatus: "COMPLETED", status: "IN_REVIEW", statusField: "data.status" }
  );
});

test("VOVE rejected outcome remains rejected", () => {
  assert.deepEqual(
    normalizeVoveOutcome({ type: "kyc.case.rejected", data: {} }, {}, { subjectType: "INDIVIDUAL" }),
    { providerStatus: "REJECTED", status: "REJECTED", statusField: "event.type" }
  );
});

test("Svix webhook signature validates signed id, timestamp and exact raw body", () => {
  const key = Buffer.from("local-test-svix-secret");
  const secret = `whsec_${key.toString("base64")}`;
  const body = '{"type":"user.verification.successful","refId":"stablex_kyc_test"}';
  const headers = { id: "msg_test_123", timestamp: "1794277641" };
  const signedContent = `${headers.id}.${headers.timestamp}.${body}`;
  const signature = createHmac("sha256", key).update(signedContent).digest("base64");
  const signedHeaders = { ...headers, signature: `v1,${signature}` };
  const now = Number(headers.timestamp) * 1000;

  assert.equal(verifyVoveWebhookSignature(body, signedHeaders, secret, { now }), true);
  assert.equal(verifyVoveWebhookSignature(body + " ", signedHeaders, secret, { now }), false);
  assert.equal(verifyVoveWebhookSignature(body, signedHeaders, secret, { now: now + 600_000 }), false);
  assert.equal(verifyVoveWebhookSignature(body, signedHeaders, "wrong-secret", { now }), false);
});
