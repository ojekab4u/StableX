// Generalized synthetic-rate engine used by the routing engine when no real
// provider covers a corridor, so the whole quote -> select -> lifecycle flow
// can be exercised before provider credentials arrive.
//
// Rates are derived from one anchor table (units of asset per 1 USD) so any
// registered pair converts directly, e.g. NGN->CAD = cngnToUsd... simply
// anchor[from] / anchor[to]. Semantics: anchor[X] = units of X per 1 USD.
//
// These are documented, deterministic synthetic rates for development only.
// Every quote carries quoteType "SIMULATION" and executable:false upstream.

// Approximate reference magnitudes, refreshed during development cycles only.
const PER_USD = {
  USD: 1,
  USDC: 1,
  USDT: 1,
  CADC: 1.004,
  CADD: 1.003,
  QCAD: 1.005,
  CAD: 1.44,
  EUR: 0.92,
  EURC: 0.919,
  GBP: 0.78,
  NGN: 1495,
  CNGN: 1494,
  KES: 129,
  UGX: 3620,
  TZS: 2470,
  GHS: 10.6,
  ZAR: 18.4,
  XAF: 621,
  XOF: 621,
};

// Same personas as the original demo engine (Consistent so earlier test data
// and screenshots stay comparable).
const SIMULATION_PROVIDERS = [
  { id: "sim-a", name: "Provider A", adjustment: 1.0, feeRate: 0.001, fixedFee: 0.25, processingTime: "About 2 minutes", liquidityUsd: 25000 },
  { id: "sim-b", name: "Provider B", adjustment: 0.998, feeRate: 0.002, fixedFee: 0.25, processingTime: "About 30 minutes", liquidityUsd: 25000 },
  { id: "sim-c", name: "Provider C", adjustment: 0.9965, feeRate: 0.0005, fixedFee: 0.25, processingTime: "About 3 minutes", liquidityUsd: 25000 },
];

function anchorOf(code) {
  return PER_USD[String(code || "").toUpperCase()] ?? null;
}

export function isSimulationSupported(from, to) {
  return Boolean(anchorOf(from) && anchorOf(to) && String(from).toUpperCase() !== String(to).toUpperCase());
}

export function rateFor(from, to) {
  const fromAnchor = anchorOf(from);
  const toAnchor = anchorOf(to);
  if (fromAnchor === null || toAnchor === null) return null;
  // anchors are units-per-USD, so units of `to` per unit of `from` is:
  // (anchor[to] / anchor[from]) — e.g. NGN->CAD = 1.44/1495 CAD per NGN.
  return toAnchor / fromAnchor;
}

function providerLiquidityIn(provider, currency) {
  const anchor = anchorOf(currency);
  if (anchor === null) return null;
  return provider.liquidityUsd * anchor; // output inventory worth liquidityUsd USD
}

export async function getSimulationQuotes({ from, to, amount }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error("Simulation amount must be greater than zero.");
    error.statusCode = 400;
    throw error;
  }
  if (!isSimulationSupported(from, to)) {
    throw new Error("No reference anchor exists for this currency pair.");
  }

  const requestFrom = String(from).toUpperCase();
  const requestTo = String(to).toUpperCase();
  const baseRate = rateFor(requestFrom, requestTo);

  const quotes = SIMULATION_PROVIDERS.map((provider) => {
    const providerRate = baseRate * provider.adjustment;
    const grossAmount = amount * providerRate;
    const fee = grossAmount * provider.feeRate + provider.fixedFee;
    const netAmount = grossAmount - fee;

    const availableOutput = providerLiquidityIn(provider, requestTo);
    if (!Number.isFinite(availableOutput) || availableOutput < grossAmount) return null;
    if (netAmount <= 0) return null;

    return {
      id: `${provider.id}-${crypto.randomUUID()}`,
      provider: provider.name,
      from: requestFrom,
      to: requestTo,
      rate: providerRate,
      grossAmount,
      fee,
      netAmount,
      feeCurrency: requestTo,
      processingTime: provider.processingTime,
      quoteType: "SIMULATION",
      executable: false,
      status: "AVAILABLE",
      liquidityCheck: {
        model: "SIMULATION",
        requestedOutput: grossAmount,
        availableOutput,
        remainingOutput: availableOutput - grossAmount,
        sufficient: true,
      },
      route: [requestFrom, requestTo],
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
  }).filter(Boolean);

  if (quotes.length === 0) {
    throw new Error("No simulation provider currently has sufficient simulated output liquidity for this amount.");
  }

  return quotes.sort((a, b) => b.netAmount - a.netAmount);
}
