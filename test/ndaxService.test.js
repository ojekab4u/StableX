import test from "node:test";
import assert from "node:assert/strict";
import { parseNdaxL2, walkBook, walkBookQuote, getNdaxReadiness } from "../services/providers/ndaxService.js";

// Real row shape from GetL2Snapshot (apidoc.ndax.io):
// [MDUpdateId, AccountId, ActionDateTime, ActionType, LastTradePrice,
//  OrderId, Price, ProductPairCode, Quantity, Side]  Side 0 = bid, 1 = ask.
const row = (price, quantity, side) => [7803784, 2, 1795019058007, 0, 1.4281, 1, price, 90, quantity, side];

test("parses bids and asks into sorted levels", () => {
  const book = parseNdaxL2([
    row(1.42, 10, 0),
    row(1.44, 5, 0),
    row(1.46, 7, 1),
    row(1.43, 9, 1),
  ]);
  assert.deepEqual(book.bids.map((l) => l.price), [1.44, 1.42]); // highest bid first
  assert.deepEqual(book.asks.map((l) => l.price), [1.43, 1.46]); // lowest ask first
});

test("drops unusable rows instead of failing the whole book", () => {
  const book = parseNdaxL2([
    row(1.42, 10, 0),
    row(0, 10, 0),        // zero price
    row(1.44, 0, 1),      // zero quantity
    [0, 0, 0, 0, 0, 0],   // truncated row
    null,                 // junk
  ]);
  assert.equal(book.bids.length, 1);
  assert.equal(book.asks.length, 0);
});

test("selling into bids returns proceeds and average price", () => {
  const book = parseNdaxL2([row(1.42, 5, 0), row(1.40, 5, 0)]);
  const walk = walkBook(book.bids, 6, "SELL_BASE");
  // 5 @ 1.42 + 1 @ 1.40 = 7.10 + 1.40 = 8.50
  assert.ok(Math.abs(walk.proceeds - 8.5) < 1e-9);
  assert.ok(Math.abs(walk.averagePrice - 8.5 / 6) < 1e-9);
  assert.equal(walk.levelsUsed.length, 2);
});

test("returns null when the book cannot cover the size", () => {
  const book = parseNdaxL2([row(1.42, 5, 0)]);
  assert.equal(walkBook(book.bids, 6, "SELL_BASE"), null);
});

test("exact-size fill consumes one level and covers fully", () => {
  const book = parseNdaxL2([row(1.44, 4, 1)]);
  const walk = walkBook(book.asks, 4, "BUY_BASE");
  assert.ok(Math.abs(walk.proceeds - 5.76) < 1e-9);
  assert.equal(walk.leftover, 0);
});

test("buying base with quote spends the quote and returns base received", () => {
  const book = parseNdaxL2([row(1.4325, 4, 1), row(1.44, 4, 1)]);
  const walk = walkBookQuote(book.asks, 2.865);
  // 2.865 CAD at 1.4325 -> 2 USDC, all spent on the first level
  assert.ok(Math.abs(walk.received - 2) < 1e-9);
  assert.ok(Math.abs(walk.averagePrice - 1.4325) < 1e-9);
  assert.ok(Math.abs(walk.leftover) < 1e-9);
});

test("buying with quote walks to the next ask when the first runs out", () => {
  const book = parseNdaxL2([row(1.4325, 1, 1), row(1.44, 4, 1)]);
  const walk = walkBookQuote(book.asks, 4.3125);
  // 1 USDC @ 1.4325 + 2 USDC @ 1.44 = 4.3125 CAD for 3 USDC
  assert.ok(Math.abs(walk.received - 3) < 1e-9);
  assert.ok(Math.abs(walk.averagePrice - 4.3125 / 3) < 1e-9);
});

test("buying with quote returns null when the CAD exceeds available depth", () => {
  const book = parseNdaxL2([row(1.4325, 1, 1)]);
  assert.equal(walkBookQuote(book.asks, 100), null);
});

test("readiness reports missing Ndax variables when none are set", () => {
  const saved = {
    key: process.env.NDAX_API_KEY,
    secret: process.env.NDAX_API_SECRET,
    userId: process.env.NDAX_USER_ID,
  };
  delete process.env.NDAX_API_KEY;
  delete process.env.NDAX_API_SECRET;
  delete process.env.NDAX_USER_ID;
  try {
    const readiness = getNdaxReadiness();
    assert.equal(readiness.configured, false);
    assert.deepEqual(readiness.missingVariables, ["NDAX_API_KEY", "NDAX_API_SECRET", "NDAX_USER_ID"]);
    assert.equal(readiness.executionEnabled, false);
  } finally {
    if (saved.key !== undefined) process.env.NDAX_API_KEY = saved.key;
    if (saved.secret !== undefined) process.env.NDAX_API_SECRET = saved.secret;
    if (saved.userId !== undefined) process.env.NDAX_USER_ID = saved.userId;
  }
});
