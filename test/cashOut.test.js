import test from "node:test";
import assert from "node:assert/strict";
import { validateCashOutRequest } from "../services/cashOutService.js";

test("a valid request normalizes the amount and keeps the key", () => {
  const result = validateCashOutRequest({ amount: "10.005", idempotencyKey: "key-1" });
  assert.equal(result.amount, 10.005);
  assert.equal(result.idempotencyKey, "key-1");
});

test("a whole number amount is accepted", () => {
  const result = validateCashOutRequest({ amount: 10, idempotencyKey: "key-2" });
  assert.equal(result.amount, 10);
});

test("zero, negative and non-numeric amounts are rejected", () => {
  for (const amount of [0, -5, "abc", undefined, null]) {
    assert.throws(() => validateCashOutRequest({ amount, idempotencyKey: "k" }), /positive amount/i);
  }
});

test("more than 3 decimal places is rejected", () => {
  assert.throws(
    () => validateCashOutRequest({ amount: 10.0005, idempotencyKey: "k" }),
    /3 decimal places/i
  );
});

test("3 decimal places is accepted", () => {
  const result = validateCashOutRequest({ amount: 10.001, idempotencyKey: "k" });
  assert.equal(result.amount, 10.001);
});

test("a missing or oversized idempotencyKey is rejected", () => {
  assert.throws(() => validateCashOutRequest({ amount: 10 }), /idempotencyKey/i);
  assert.throws(() => validateCashOutRequest({ amount: 10, idempotencyKey: "" }), /idempotencyKey/i);
  assert.throws(
    () => validateCashOutRequest({ amount: 10, idempotencyKey: "x".repeat(256) }),
    /idempotencyKey/i
  );
});
