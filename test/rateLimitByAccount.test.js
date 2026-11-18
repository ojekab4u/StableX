import test from "node:test";
import assert from "node:assert/strict";
import { rateLimitByAccount } from "../middleware/rateLimitByAccount.js";

const run = (limiter, accountId) => {
  const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  let passed = false;
  limiter({ account: { accountId } }, res, () => { passed = true; });
  return passed ? 200 : res.statusCode;
};

test("allows up to the max per account, then returns 429", () => {
  const limiter = rateLimitByAccount({ windowMs: 60000, max: 3, label: "test" });
  assert.deepEqual([1, 2, 3, 4].map(() => run(limiter, "acct-a")), [200, 200, 200, 429]);
});

test("counts each account separately", () => {
  const limiter = rateLimitByAccount({ windowMs: 60000, max: 1, label: "test" });
  assert.equal(run(limiter, "acct-x"), 200);
  assert.equal(run(limiter, "acct-y"), 200);
  assert.equal(run(limiter, "acct-x"), 429);
});
