

import { randomUUID } from 'node:crypto';

// Demonstration exchange rates.
// Simulated values only
const DEMO_RATES = Object.freeze({
  'USDT-NGN': 1500,
  'USDC-NGN': 1495,

  'NGN-USDT': 1 / 1500,
  'NGN-USDC': 1 / 1495,

  'USDT-USDC': 0.999,
  'USDC-USDT': 0.999,
});

// Each provider has independent pricing, fees and simulated inventory.
// Inventory represents the maximum output asset the provider can supply.
const demoProviders = [
  {
    id: 'provider-a',
    name: 'Provider A',

    feeRate: 0.001,
    fixedFee: 0.10,
    rateAdjustment: 1,

    processingTime: 'About 1 minute',

    outputLiquidity: {
      NGN: 2000000,
      USDT: 1500,
      USDC: 1500,
    },
  },

  {
    id: 'provider-b',
    name: 'Provider B',

    feeRate: 0.002,
    fixedFee: 0.05,
    rateAdjustment: 0.997,

    processingTime: 'About 2 minutes',

    outputLiquidity: {
      NGN: 12000000,
      USDT: 15000,
      USDC: 15000,
    },
  },

  {
    id: 'provider-c',
    name: 'Provider C',

    feeRate: 0.0005,
    fixedFee: 0.25,
    rateAdjustment: 0.998,

    processingTime: 'About 3 minutes',

    outputLiquidity: {
      NGN: 5000000,
      USDT: 5000,
      USDC: 5000,
    },
  },
];

// Generate one quote from one provider.
async function createProviderQuote({
  provider,
  amount,
  from,
  to,
  baseRate,
}) {
  // Apply the provider's individual exchange-rate adjustment.
  const providerRate = baseRate * provider.rateAdjustment;

  // Calculate the expected output before fees.
  const grossAmount = amount * providerRate;

  // Provider fee is calculated in the output currency.
  const fee =
    grossAmount * provider.feeRate + provider.fixedFee;

  const netAmount = grossAmount - fee;

  // Check whether this provider has enough simulated inventory.
  const availableOutput = provider.outputLiquidity[to];

  if (
    !Number.isFinite(availableOutput) ||
    availableOutput < grossAmount
  ) {
    return null;
  }

  if (netAmount <= 0) {
    return null;
  }

  const expiresAt = new Date(
    Date.now() + 30000
  ).toISOString();

  return {
    id: `${provider.id}-${randomUUID()}`,

    provider: provider.name,

    from,
    to,

    rate: providerRate,

    grossAmount,
    fee,
    netAmount,

    feeCurrency: to,

    processingTime: provider.processingTime,

    quoteType: 'DEMO',
    executable: false,
    status: 'AVAILABLE',

    // This is a simulated inventory check, not real liquidity.
    liquidityCheck: {
      model: 'SIMULATED',
      requestedOutput: grossAmount,
      availableOutput,
      remainingOutput: availableOutput - grossAmount,
      sufficient: true,
    },

    route: [from, to],

    expiresAt,
  };
}

// Main function called by the Express API.
export async function getQuotes({ amount, from, to }) {
  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error('Amount must be greater than zero.');
  }

  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    from === to
  ) {
    throw new Error('Select two different currencies.');
  }

  const pair = `${from}-${to}`;
  const baseRate = DEMO_RATES[pair];

  if (!baseRate) {
    throw new Error(
      `Currency pair ${pair} is not supported.`
    );
  }

  // Ask all providers for quotes concurrently.
  const providerResults = await Promise.all(
    demoProviders.map(async (provider) => {
      try {
        return await createProviderQuote({
          provider,
          amount,
          from,
          to,
          baseRate,
        });
      } catch {
        // One provider failure must not stop the others.
        return null;
      }
    })
  );

  // Keep only providers that returned valid quotes.
  const availableQuotes = providerResults.filter(
    (quote) => quote !== null
  );

  if (availableQuotes.length === 0) {
    throw new Error(
      'No demo provider currently has sufficient simulated output liquidity for this amount.'
    );
  }

  // Rank providers by the amount the customer receives.
  return availableQuotes.sort(
    (a, b) => b.netAmount - a.netAmount
  );
}

// Return currency pairs supported by the simulated quote engine.
export function getDemoSupportedPairs() {
  return Object.keys(DEMO_RATES).map((pair) => {
    const [from, to] = pair.split("-");

    return { from, to };
  });
}