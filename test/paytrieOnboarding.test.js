import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  validatePaytrieRegistrationProfile,
  buildPaytrieUserPayload,
  getPaytrieRequiredFields,
  buildPaytrieRequirementsPatch,
} from "../services/paytrieOnboardingService.js";
import { verifyPaytrieWebhookSignature } from "../services/paytrieWebhookService.js";

const validProfile = {
  firstName: "Ada",
  lastName: "Lovelace",
  dateOfBirth: "1990-01-15",
  phone: "4165551234",
  addressLine1: "123 Main Street",
  addressLine2: "Unit 4",
  city: "Toronto",
  province: "on",
  postalCode: "M5V 1A1",
  occupation: "Software Engineer",
  notPepConfirmed: true,
  notThirdPartyConfirmed: true,
};

test("Paytrie registration profile accepts Canadian identity/address fields and clear declarations", () => {
  assert.deepEqual(validatePaytrieRegistrationProfile(validProfile), []);
  const payload = buildPaytrieUserPayload({ email: "ada@example.com", profile: validProfile });
  assert.equal(payload.email, "ada@example.com");
  assert.equal(payload.phone, "4165551234");
  assert.equal(payload.province, "on");
  assert.equal(payload.postalCode, "M5V1A1");
  assert.equal(payload.pep, false);
  assert.equal(payload.tpd, false);
});

test("Paytrie registration refuses missing self-attestations and invalid Canadian details", () => {
  const invalid = {
    ...validProfile,
    notPepConfirmed: false,
    notThirdPartyConfirmed: false,
    phone: "+14165551234",
    province: "zz",
    postalCode: "12345",
  };
  const problems = validatePaytrieRegistrationProfile(invalid);
  assert.ok(problems.some((item) => item.includes("not a politically exposed person")));
  assert.ok(problems.some((item) => item.includes("not for a third party")));
  assert.ok(problems.some((item) => item.includes("10-digit Canadian mobile")));
  assert.ok(problems.some((item) => item.includes("province or territory")));
  assert.ok(problems.some((item) => item.includes("postal code")));
});

test("Paytrie required-field response is flattened and deduplicated", () => {
  const required = getPaytrieRequiredFields({
    requirements: {
      additionalInfo: {
        status: "pending",
        requiredFields: [
          "olderUserInfo.sourceOfFunds",
          "olderUserInfo.walletAddress",
        ],
      },
      personalInfo: {
        status: "pending",
        requiredFields: ["firstName", "olderUserInfo.sourceOfFunds"],
      },
    },
  });
  assert.deepEqual(required, [
    "olderUserInfo.sourceOfFunds",
    "olderUserInfo.walletAddress",
    "firstName",
  ]);
});

test("Paytrie requirements patch nests olderUserInfo fields as required by the provider", () => {
  const payload = buildPaytrieRequirementsPatch(
    ["olderUserInfo.sourceOfFunds", "olderUserInfo.intendedUseOfUSDC", "firstName"],
    {
      "olderUserInfo.sourceOfFunds": "Salary",
      "olderUserInfo.intendedUseOfUSDC": "Savings",
      firstName: "Ada",
    }
  );
  assert.deepEqual(payload, {
    olderUserInfo: {
      sourceOfFunds: "Salary",
      intendedUseOfUSDC: "Savings",
    },
    firstName: "Ada",
  });
});

test("Paytrie requirements patch rejects unknown, unrequested and malformed wallet fields", () => {
  assert.throws(
    () => buildPaytrieRequirementsPatch(["olderUserInfo.unlisted"], { "olderUserInfo.unlisted": "x" }),
    /not yet supported/
  );
  assert.throws(
    () => buildPaytrieRequirementsPatch(["occupation"], { occupation: "Engineer", firstName: "Injected" }),
    /was not requested/
  );
  assert.throws(
    () => buildPaytrieRequirementsPatch(["olderUserInfo.walletAddress"], { "olderUserInfo.walletAddress": "not-a-wallet" }),
    /valid wallet address/
  );
});

test("Paytrie webhook signature verifies raw payload, signing secret and recency", () => {
  const rawBody = JSON.stringify({
    id: "event-123",
    apiVersion: "v2",
    type: "user.update",
    payload: { userId: "user-1", email: "ada@example.com", status: "verified" },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = "whsec_test_secret";
  const signature = "v1=" + createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");

  assert.equal(verifyPaytrieWebhookSignature({ rawBody, signature, timestamp, secret }), true);
  assert.equal(verifyPaytrieWebhookSignature({ rawBody: rawBody + " ", signature, timestamp, secret }), false);
  assert.equal(verifyPaytrieWebhookSignature({ rawBody, signature, timestamp, secret: "wrong" }), false);
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
  const staleSignature = "v1=" + createHmac("sha256", secret).update(staleTimestamp + "." + rawBody).digest("hex");
  assert.equal(verifyPaytrieWebhookSignature({ rawBody, signature: staleSignature, timestamp: staleTimestamp, secret }), false);
});
