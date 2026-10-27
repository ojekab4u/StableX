
const demoProviders = [
  {
    id: "provider-a",
    name: "Provider A",
    feeRate: 0.001,
    fixedFee: 0.10,
    processingTime: "About 1 minute"
  },
  {
    id: "provider-b",
    name: "Provider B",
    feeRate: 0.002,
    fixedFee: 0.05,
    processingTime: "About 2 minutes"
  },
  {
    id: "provider-c",
    name: "Provider C",
    feeRate: 0.0005,
    fixedFee: 0.25,
    processingTime: "About 3 minutes"
  }
];

// Demonstration rates. 
const demoRates = {
  "USDT-NGN": 1500,
  "USDC-NGN": 1495,
  "NGN-USDT": 1 / 1500,
  "NGN-USDC": 1 / 1495,
  "USDT-USDC": 0.999,
  "USDC-USDT": 0.999
};

export async function getQuotes({ amount, from, to }) {
  const pair = `${from}-${to}`;
  const rate = demoRates[pair];

  if (!rate) {
    throw new Error("This currency pair is not supported.");
  }

  return demoProviders
    .map((provider, index) => {
     
      const adjustment = [1, 0.997, 0.998][index];
      const providerRate = rate * adjustment;

      const grossAmount = amount * providerRate;
      const fee = grossAmount * provider.feeRate + provider.fixedFee;
      const netAmount = Math.max(0, grossAmount - fee);

      return {
        id: provider.id,
        provider: provider.name,
        from,
        to,
        rate: providerRate,
        grossAmount,
        fee,
        netAmount,
        feeCurrency: to,
        processingTime: provider.processingTime,
        quoteType: "DEMO",
        executable: false
      };
    })
    .sort((a, b) => b.netAmount - a.netAmount);
}
