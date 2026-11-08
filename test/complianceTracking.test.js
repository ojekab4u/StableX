import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { normalizeVoveOutcome } from "../services/complianceService.js";
import { verifyVoveWebhookSignature } from "../services/voveKybService.js";

test("VOVE completed verification enters internal review, not automatic approval", () => {
  assert.deepEqual(
    normalizeVoveOutcome({ type: "kyc.case.completed", data: { status: "COMPLETED" } }, { status: "COMPLETED" }),
    { providerStatus: "COMPLETED", status: "IN_REVIEW" }
  );
});

test("explicit VOVE verified outcome satisfies the verification gate", () => {
  assert.deepEqual(
    normalizeVoveOutcome({ data: {} }, { refId: "stablex_kyc_test_ref", data: { status: "VERIFIED" } }),
    { providerStatus: "VERIFIED", status: "APPROVED" }
  );
});

test("VOVE rejected outcome remains rejected", () => {
  assert.deepEqual(
    normalizeVoveOutcome({ type: "kyc.case.rejected", data: {} }, {}),
    { providerStatus: "REJECTED", status: "REJECTED" }
  );
});

test("VOVE webhook signature must match the exact raw body", () => {
  const secret = "local-test-webhook-secret";
  const body = '{"type":"kyc.case.completed","data":{"refId":"stablex_kyc_test"}}';
  const signature = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(verifyVoveWebhookSignature(body, signature, secret), true);
  assert.equal(verifyVoveWebhookSignature(body + " ", signature, secret), false);
  assert.equal(verifyVoveWebhookSignature(body, signature, ""), false);
});
