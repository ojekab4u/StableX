import test from "node:test";
import assert from "node:assert/strict";
import {
  planNdaxOrder,
  sendNdaxOrder,
  getNdaxOrderStatus,
  getNdaxReadiness,
} from "../services/providers/ndaxService.js";

// Real instrument shape from GetInstrument (instrument 90, USDCCAD).
const instrument = {
  InstrumentId: 90,
  Symbol: "USDCCAD",
  Product1Symbol: "USDC",
  Product2Symbol: "CAD",
  QuantityIncrement: 0.001,
  PriceIncrement: 0.0001,
  MinimumQuantity: 1,
};

const book = {
  bids: [{ price: 1.4281, quantity: 5 }, { price: 1.42, quantity: 5 }],
  asks: [{ price: 1.4325, quantity: 4 }],
};

test("a sell is priced at the best bid because it lifts bids", () => {
  const plan = planNdaxOrder({ side: "SELL", quantity: 10, book, instrument });
  assert.equal(plan.sideCode, 1);
  assert.equal(plan.limitPrice, 1.4281);
  assert.equal(plan.priceSource, "BEST_BID");
  assert.equal(plan.instrumentId, 90);
});

test("a buy is priced at the best ask because it lifts asks", () => {
  const plan = planNdaxOrder({ side: "BUY", quantity: 10, book, instrument });
  assert.equal(plan.sideCode, 0);
  assert.equal(plan.limitPrice, 1.4325);
  assert.equal(plan.priceSource, "BEST_ASK");
});

test("an operator-supplied limit price overrides the touched price", () => {
  const plan = planNdaxOrder({ side: "SELL", quantity: 10, book, instrument, limitPrice: 1.4 });
  assert.equal(plan.limitPrice, 1.4);
  assert.equal(plan.priceSource, "OPERATOR_SUPPLIED");
  assert.equal(plan.touchedPrice, 1.4281);
});

test("rejects an unknown side", () => {
  assert.throws(
    () => planNdaxOrder({ side: "SHORT", quantity: 10, book, instrument }),
    (error) => error.statusCode === 400 && /BUY or SELL/.test(error.message)
  );
});

test("rejects a missing or non-positive quantity", () => {
  for (const quantity of [undefined, 0, -5, "abc"]) {
    assert.throws(
      () => planNdaxOrder({ side: "SELL", quantity, book, instrument }),
      (error) => error.statusCode === 400
    );
  }
});

test("rejects a quantity below the 1 USDC minimum", () => {
  assert.throws(
    () => planNdaxOrder({ side: "SELL", quantity: 0.5, book, instrument }),
    (error) => error.statusCode === 400 && /minimum order size is 1 USDC/i.test(error.message)
  );
});

test("rounds quantity to the increment without float drift", () => {
  // 10 / 0.001 is 9999.999999999998; a naive floor would order 9.999.
  assert.equal(planNdaxOrder({ side: "SELL", quantity: 10, book, instrument }).quantity, 10);
  assert.equal(planNdaxOrder({ side: "SELL", quantity: 10.0009, book, instrument }).quantity, 10);
  assert.equal(planNdaxOrder({ side: "SELL", quantity: 2.5, book, instrument }).quantity, 2.5);
});

test("rounds the limit price to the price increment", () => {
  const plan = planNdaxOrder({ side: "SELL", quantity: 10, book, instrument, limitPrice: 1.42816 });
  assert.equal(plan.limitPrice, 1.4282);
});

test("refuses a book whose base is not USDC", () => {
  assert.throws(
    () => planNdaxOrder({ side: "SELL", quantity: 10, book, instrument: { ...instrument, Product1Symbol: "CAD" } }),
    (error) => error.statusCode === 409 && /USDC as the base/.test(error.message)
  );
});

test("refuses to price an order when that side of the book is empty", () => {
  assert.throws(
    () => planNdaxOrder({ side: "SELL", quantity: 10, book: { bids: [], asks: book.asks }, instrument }),
    (error) => error.statusCode === 409 && /no liquidity/.test(error.message)
  );
});

test("refuses to plan without a resolved instrument", () => {
  assert.throws(
    () => planNdaxOrder({ side: "SELL", quantity: 10, book, instrument: null }),
    (error) => error.statusCode === 404
  );
});

test("execution stays disabled without NDAX_EXECUTION_ENABLED", async () => {
  delete process.env.NDAX_EXECUTION_ENABLED;
  assert.equal(getNdaxReadiness().executionEnabled, false);
  await assert.rejects(
    sendNdaxOrder({ side: "SELL", quantity: 10 }),
    (error) => error.statusCode === 403 && /NDAX_EXECUTION_ENABLED=true/.test(error.message)
  );
});

test("status polling is not gated — only placement is", async () => {
  // Reads must work in read-only mode; this must fail on credentials, not on 403.
  delete process.env.NDAX_EXECUTION_ENABLED;
  await assert.rejects(getNdaxOrderStatus(0), (error) => error.statusCode === 400);
});

test("enabling the flag without credentials still refuses to trade", async () => {
  process.env.NDAX_EXECUTION_ENABLED = "true";
  try {
    assert.equal(getNdaxReadiness().executionEnabled, true);
    // The test suite never loads .env, so credentials are absent here.
    await assert.rejects(
      sendNdaxOrder({ side: "SELL", quantity: 10 }),
      (error) => error.statusCode === 503 && /credentials are not configured/.test(error.message)
    );
  } finally {
    delete process.env.NDAX_EXECUTION_ENABLED;
  }
});

test("readiness reports execution capability only when the flag is on", () => {
  delete process.env.NDAX_EXECUTION_ENABLED;
  const off = getNdaxReadiness();
  assert.equal(off.executionEnabled, false);
  assert.equal(off.capabilities.includes("ORDER_PLACEMENT_SENDORDER_USDC_CAD"), false);

  process.env.NDAX_EXECUTION_ENABLED = "true";
  try {
    const on = getNdaxReadiness();
    assert.equal(on.executionEnabled, true);
    assert.equal(on.capabilities.includes("ORDER_PLACEMENT_SENDORDER_USDC_CAD"), true);
    assert.equal(on.capabilities.includes("CAD_BANK_PAYOUT_CREATE_WITHDRAW_TICKET"), true);
  } finally {
    delete process.env.NDAX_EXECUTION_ENABLED;
  }
});
