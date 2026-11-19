import test from "node:test";
import assert from "node:assert/strict";
import { NDAX_FEES, STABLEX_MARGIN, quoteCashOut, quoteFund, cashOutPayout } from "../config/fees.js";

test("cash-out quote deducts the trade fee and the Interac transfer fee", () => {
  const q = quoteCashOut({ amountUsdc: 2, priceCadPerUsdc: 1.4306, payoutMethod: "INTERAC" });
  assert.ok(Math.abs(q.grossCad - 2.8612) < 1e-9);
  assert.ok(Math.abs(q.tradeFeeCad - 0.0057224) < 1e-9);
  assert.equal(q.transferFeeCad, 1.5);
  assert.equal(q.marginCad, 0);
  assert.ok(Math.abs(q.youReceiveCad - (2.8612 - 0.0057224 - 1.5)) < 1e-9);
});

test("cash-out quote uses the EFT fee when EFT is chosen", () => {
  const q = quoteCashOut({ amountUsdc: 2, priceCadPerUsdc: 1.4306, payoutMethod: "EFT" });
  assert.equal(q.transferFeeCad, NDAX_FEES.payoutEftCad);
});

test("fund quote returns the USDC net of the trading fee", () => {
  const q = quoteFund({ cadAmount: 2, priceCadPerUsdc: 1.4352 });
  assert.ok(Math.abs(q.grossUsdc - 2 / 1.4352) < 1e-9);
  assert.ok(Math.abs(q.tradeFeeUsdc - q.grossUsdc * 0.002) < 1e-9);
  assert.ok(Math.abs(q.youReceiveUsdc - q.grossUsdc * 0.998) < 1e-9);
});

test("payout plan: the ticket is gross of the transfer fee, the customer receives net", () => {
  const p = cashOutPayout({ quantityExecuted: 2, averagePriceCad: 1.4306, payoutMethod: "INTERAC" });
  assert.ok(Math.abs(p.grossCad - 2.8612) < 1e-9);
  assert.ok(Math.abs(p.tradeFeeCad - 0.0057224) < 1e-9);
  assert.ok(Math.abs(p.netCad - 2.8554776) < 1e-9);
  assert.equal(p.ticketAmountCad, p.netCad);
  assert.equal(p.transferFeeCad, 1.5);
  assert.ok(Math.abs(p.customerReceivesCad - 1.3554776) < 1e-9);
});

test("payout plan with EFT uses the 4.99 fee", () => {
  const p = cashOutPayout({ quantityExecuted: 2, averagePriceCad: 1.4306, payoutMethod: "EFT" });
  assert.equal(p.transferFeeCad, 4.99);
  assert.ok(p.customerReceivesCad < 0); // small test amounts cannot go via EFT
});

test("the margin slots flow into both quotes when set", () => {  const saved = { ...NDAX_FEES, ...STABLEX_MARGIN };
  STABLEX_MARGIN.cashOutPct = 0.01;
  STABLEX_MARGIN.fundPct = 0.01;
  try {
    const out = quoteCashOut({ amountUsdc: 2, priceCadPerUsdc: 1.4306 });
    assert.ok(Math.abs(out.marginCad - 0.028612) < 1e-9);
    const fund = quoteFund({ cadAmount: 2, priceCadPerUsdc: 1.4352 });
    assert.ok(Math.abs(fund.marginUsdc - fund.grossUsdc * 0.01) < 1e-9);
  } finally {
    STABLEX_MARGIN.cashOutPct = saved.cashOutPct;
    STABLEX_MARGIN.fundPct = saved.fundPct;
  }
});
