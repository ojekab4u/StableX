import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildCadPayoutRequest, verifyFincraWebhookSignature } from "../services/providers/fincraService.js";

const recipient = {
  firstName: "John",
  lastName: "Barret",
  accountHolderName: "John Barret",
  interacEmail: "john@example.com",
  type: "individual",
};

test("a valid CAD payout builds the documented request shape", () => {
  process.env.FINCRA_BUSINESS_ID = "biz123";
  const request = buildCadPayoutRequest({
    amount: 100,
    description: "Cashtella payout",
    customerReference: "ref-001",
    recipient,
  });
  assert.equal(request.destinationCurrency, "CAD");
  assert.equal(request.paymentScheme, "interac");
  assert.equal(request.paymentDestination, "bank_account");
  assert.equal(request.beneficiary.country, "CA");
  assert.equal(request.amount, 100);
  delete process.env.FINCRA_BUSINESS_ID;
});

test("cross-currency payouts require a quote reference", () => {
  assert.throws(
    () => buildCadPayoutRequest({ amount: 100, description: "d", customerReference: "r", recipient, sourceCurrency: "NGN" }),
    /quoteReference/i
  );
});

test("recipients without autodeposit need a usable security question and answer", () => {
  assert.throws(
    () => buildCadPayoutRequest({ amount: 100, description: "d", customerReference: "r", recipient: { ...recipient, autoDepositEnabled: false } }),
    /security question/i
  );
  assert.throws(
    () => buildCadPayoutRequest({
      amount: 100, description: "d", customerReference: "r",
      recipient: { ...recipient, autoDepositEnabled: false, securityQuestion: "Q", securityAnswer: "has space" },
    }),
    /security answer/i
  );
});

test("corporate recipients take a business name instead of names", () => {
  process.env.FINCRA_BUSINESS_ID = "biz123";
  const request = buildCadPayoutRequest({
    amount: 250,
    description: "Invoice 4471",
    customerReference: "r",
    recipient: { type: "corporate", accountHolderName: "Maple Leaf Supplies Inc", interacEmail: "ap@maple.ca" },
  });
  assert.equal(request.beneficiary.type, "corporate");
  assert.equal(request.beneficiary.accountHolderName, "Maple Leaf Supplies Inc");
  delete process.env.FINCRA_BUSINESS_ID;
});

test("webhook signature: correct HMAC SHA512 passes, tampering fails", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ event: "collection.successful", data: { reference: "FNC-CAD-1" } });
  process.env.FINCRA_WEBHOOK_SECRET = secret;
  const good = createHmac("sha512", secret).update(body).digest("hex");
  assert.equal(verifyFincraWebhookSignature(body, good), true);
  assert.equal(verifyFincraWebhookSignature(body + " ", good), false);
  assert.equal(verifyFincraWebhookSignature(body, good.slice(0, -2) + "zz"), false);
  assert.equal(verifyFincraWebhookSignature(body, undefined), false);
  delete process.env.FINCRA_WEBHOOK_SECRET;
});
