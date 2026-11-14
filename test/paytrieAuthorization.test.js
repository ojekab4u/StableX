import test from "node:test";
import assert from "node:assert/strict";
import {
  getPaytrieExecutionReadiness,
  isPaytriePlatformExecutionApproved,
  isPaytriePersonalTestModeEnabled,
  createPaytrieOrder,
} from "../services/paytrieExecutionService.js";
import { getPaytrieReadiness } from "../services/paytrieService.js";

const envKeys = [
  "PAYTRIE_API_KEY",
  "PAYTRIE_PLATFORM_EXECUTION_APPROVED",
  "PAYTRIE_PERSONAL_TEST_MODE",
  "PAYTRIE_PERSONAL_TEST_CUSTOMER_ID",
];
function snapshotEnv() {
  return Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
}
function restoreEnv(previous) {
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

test("Paytrie platform execution remains disabled when platform approval is absent", () => {
  const previous = snapshotEnv();
  try {
    process.env.PAYTRIE_API_KEY = "test-paytrie-api-key";
    delete process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED;
    delete process.env.PAYTRIE_PERSONAL_TEST_MODE;
    delete process.env.PAYTRIE_PERSONAL_TEST_CUSTOMER_ID;
    const readiness = getPaytrieExecutionReadiness();
    assert.equal(readiness.apiKeyPresent, true);
    assert.equal(readiness.platformAuthorizationRequired, true);
    assert.equal(readiness.platformExecutionApproved, false);
    assert.equal(readiness.personalTestModeEnabled, false);
    assert.equal(readiness.transactionCreationEnabled, false);
    assert.equal(readiness.status, "PAYTRIE_PLATFORM_APPROVAL_REQUIRED");
    assert.equal(getPaytrieReadiness().transactionCreationEnabled, false);
    assert.equal(getPaytrieReadiness().platformExecutionApproved, false);
  } finally { restoreEnv(previous); }
});

test("Paytrie platform approval flag accepts only the literal true value", () => {
  const previous = snapshotEnv();
  try {
    for (const value of ["", "yes", "1", "approved"]) {
      process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED = value;
      assert.equal(isPaytriePlatformExecutionApproved(), false);
    }
    process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED = "true";
    assert.equal(isPaytriePlatformExecutionApproved(), true);
  } finally { restoreEnv(previous); }
});

test("personal test mode is limited to one configured StableX PERSONAL account", () => {
  const previous = snapshotEnv();
  try {
    process.env.PAYTRIE_PERSONAL_TEST_MODE = "true";
    process.env.PAYTRIE_PERSONAL_TEST_CUSTOMER_ID = "stablex-personal-test-001";
    process.env.PAYTRIE_API_KEY = "test-paytrie-api-key";
    delete process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED;

    assert.equal(isPaytriePersonalTestModeEnabled("stablex-personal-test-001", "PERSONAL"), true);
    assert.equal(isPaytriePersonalTestModeEnabled("another-customer", "PERSONAL"), false);
    assert.equal(isPaytriePersonalTestModeEnabled("stablex-personal-test-001", "BUSINESS"), false);

    const readiness = getPaytrieExecutionReadiness({
      customerId: "stablex-personal-test-001",
      accountType: "PERSONAL",
    });
    assert.equal(readiness.personalTestModeEnabled, true);
    assert.equal(readiness.platformExecutionApproved, false);
    assert.equal(readiness.transactionCreationEnabled, true);
    assert.equal(readiness.status, "PERSONAL_ACCOUNT_TEST_MODE_READY");
  } finally { restoreEnv(previous); }
});

test("personal test mode cannot submit an order for any other StableX customer", async () => {
  const previous = snapshotEnv();
  try {
    process.env.PAYTRIE_PERSONAL_TEST_MODE = "true";
    process.env.PAYTRIE_PERSONAL_TEST_CUSTOMER_ID = "stablex-personal-test-001";
    delete process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED;
    await assert.rejects(
      createPaytrieOrder({
        transferId: "00000000-0000-4000-8000-000000000001",
        customerId: "different-customer",
        accountType: "PERSONAL",
        confirm: true,
      }),
      (error) => error.statusCode === 403 && /single StableX PERSONAL account/i.test(error.message)
    );
  } finally { restoreEnv(previous); }
});

test("configured personal test account still requires explicit order confirmation", async () => {
  const previous = snapshotEnv();
  try {
    process.env.PAYTRIE_PERSONAL_TEST_MODE = "true";
    process.env.PAYTRIE_PERSONAL_TEST_CUSTOMER_ID = "stablex-personal-test-001";
    delete process.env.PAYTRIE_PLATFORM_EXECUTION_APPROVED;
    await assert.rejects(
      createPaytrieOrder({
        transferId: "00000000-0000-4000-8000-000000000001",
        customerId: "stablex-personal-test-001",
        accountType: "PERSONAL",
        confirm: false,
      }),
      (error) => error.statusCode === 400 && /explicit confirmation/i.test(error.message)
    );
  } finally { restoreEnv(previous); }
});
