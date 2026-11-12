import test from "node:test";
import assert from "node:assert/strict";
import { getPaytrieExecutionReadiness, isPaytriePlatformExecutionApproved } from "../services/paytrieExecutionService.js";
import { getPaytrieReadiness } from "../services/paytrieService.js";

test("Paytrie execution remains disabled when platform approval is absent, even with an API key", () => {
  const oldKey = process.env.PAYTRIE_API_KEY;
  const oldApproval = process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED;
  process.env.PAYTRIE_API_KEY = "test-paytrie-api-key";
  delete process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED;
  try {
    const readiness = getPaytrieExecutionReadiness();
    assert.equal(readiness.apiKeyPresent, true);
    assert.equal(readiness.platformAuthorizationRequired, true);
    assert.equal(readiness.platformExecutionApproved, false);
    assert.equal(readiness.transactionCreationEnabled, false);
    assert.equal(readiness.status, "PAYTRIE_PLATFORM_APPROVAL_REQUIRED");
    assert.equal(getPaytrieReadiness().transactionCreationEnabled, false);
    assert.equal(getPaytrieReadiness().platformExecutionApproved, false);
  } finally {
    if (oldKey === undefined) delete process.env.PAYTRIE_API_KEY; else process.env.PAYTRIE_API_KEY = oldKey;
    if (oldApproval === undefined) delete process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED; else process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED = oldApproval;
  }
});

test("Paytrie platform approval flag accepts only the literal true value", () => {
  const oldApproval = process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED;
  try {
    for (const value of ["", "yes", "1", "approved"]) {
      process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED = value;
      assert.equal(isPaytriePlatformExecutionApproved(), false);
    }
    process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED = "true";
    assert.equal(isPaytriePlatformExecutionApproved(), true);
  } finally {
    if (oldApproval === undefined) delete process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED; else process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED = oldApproval;
  }
});
