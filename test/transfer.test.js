import test from "node:test";
import assert from "node:assert/strict";
import { validateTransferRequest } from "../services/internalTransferService.js";

test("a valid transfer request normalizes email and amount", () => {
  const r = validateTransferRequest({ amount: "10.5", idempotencyKey: "k1", toEmail: " Ada@Example.COM " });
  assert.equal(r.amount, 10.5);
  assert.equal(r.toEmail, "ada@example.com");
  assert.equal(r.idempotencyKey, "k1");
});

test("zero, negative and non-numeric amounts are rejected", () => {
  for (const amount of [0, -1, "abc", undefined]) {
    assert.throws(() => validateTransferRequest({ amount, idempotencyKey: "k", toEmail: "a@b.co" }), /positive amount/i);
  }
});

test("more than 6 decimals is rejected", () => {
  assert.throws(() => validateTransferRequest({ amount: 0.0000001, idempotencyKey: "k", toEmail: "a@b.co" }), /6 decimal/i);
});

test("6 decimals is accepted", () => {
  const r = validateTransferRequest({ amount: 0.000001, idempotencyKey: "k", toEmail: "a@b.co" });
  assert.equal(r.amount, 0.000001);
});

test("invalid recipient emails are rejected", () => {
  for (const toEmail of ["", "not-an-email", undefined]) {
    assert.throws(() => validateTransferRequest({ amount: 1, idempotencyKey: "k", toEmail }), /recipient email/i);
  }
});

test("a missing idempotencyKey is rejected", () => {
  assert.throws(() => validateTransferRequest({ amount: 1, toEmail: "a@b.co" }), /idempotencyKey/i);
});
