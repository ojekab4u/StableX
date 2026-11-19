// Provider fees for the Ndax CAD leg, in one place, verified against the
// live ledger (0.20% taken from every fill; sells in CAD, buys in USDC).
// The StableX margin fields are the slot for our own charges: set them and
// every quote and credit picks them up — no other file needs changing.
export const NDAX_FEES = {
  tradingRate: 0.002,
  payoutInteracCad: 1.5, // 0-30 min, max 10,000 CAD per 24h
  payoutEftCad: 4.99,    // 0-1 business day, no limit
};

export const STABLEX_MARGIN = {
  cashOutPct: 0, // fraction of the CAD gross
  fundPct: 0,    // fraction of the USDC gross
};

export function payoutFeeCad(payoutMethod = "INTERAC") {
  return payoutMethod === "EFT" ? NDAX_FEES.payoutEftCad : NDAX_FEES.payoutInteracCad;
}

// Cash out: the customer is debited amountUsdc and eventually receives CAD in
// their bank. Fees come out of the CAD proceeds.
export function quoteCashOut({ amountUsdc, priceCadPerUsdc, payoutMethod = "INTERAC" }) {
  const grossCad = Number(amountUsdc) * Number(priceCadPerUsdc);
  const tradeFeeCad = grossCad * NDAX_FEES.tradingRate;
  const marginCad = grossCad * STABLEX_MARGIN.cashOutPct;
  const transferFeeCad = payoutFeeCad(payoutMethod);
  const youReceiveCad = grossCad - tradeFeeCad - marginCad - transferFeeCad;
  return {
    amountUsdc: Number(amountUsdc),
    priceCadPerUsdc: Number(priceCadPerUsdc),
    payoutMethod,
    grossCad,
    tradeFeeCad,
    marginCad,
    transferFeeCad,
    youReceiveCad,
  };
}

// Fund: the customer sends cadAmount and receives USDC net of fees.
export function quoteFund({ cadAmount, priceCadPerUsdc }) {
  const grossUsdc = Number(cadAmount) / Number(priceCadPerUsdc);
  const tradeFeeUsdc = grossUsdc * NDAX_FEES.tradingRate;
  const marginUsdc = grossUsdc * STABLEX_MARGIN.fundPct;
  const youReceiveUsdc = grossUsdc - tradeFeeUsdc - marginUsdc;
  return {
    cadAmount: Number(cadAmount),
    priceCadPerUsdc: Number(priceCadPerUsdc),
    grossUsdc,
    tradeFeeUsdc,
    marginUsdc,
    youReceiveUsdc,
  };
}
