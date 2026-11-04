import { getHoneycoinRate, getHoneycoinReadiness } from "./honeycoinService.js";
import { getPaycrestRate, getPaycrestReadiness } from "./paycrestService.js";

export function getProviderReadiness() {
  return {
    mode: "PROVIDER_ADAPTER_PREPARATION",
    executionEnabled: false,
    providers: [getHoneycoinReadiness(), getPaycrestReadiness()],
    note: "Configuration presence is not a successful connection test, provider approval, live liquidity confirmation or permission to move funds.",
  };
}

export async function getProviderRatePreviews({ from, to, amount, network = "base", provider = "all" }) {
  const selected = provider.toLowerCase();
  const tasks = [];

  if (selected === "all" || selected === "honeycoin") {
    tasks.push(["Honeycoin", () => getHoneycoinRate({ from, to, amount })]);
  }
  if (selected === "all" || selected === "paycrest") {
    tasks.push(["Paycrest", () => getPaycrestRate({ from, to, amount, network })]);
  }
  if (!tasks.length) {
    const error = new Error("Provider must be honeycoin, paycrest, or all.");
    error.statusCode = 400;
    throw error;
  }

  const results = await Promise.all(tasks.map(async ([name, run]) => {
    try {
      return { provider: name, available: true, quote: await run() };
    } catch (error) {
      return {
        provider: name,
        available: false,
        error: error.message,
        statusCode: error.statusCode || 502,
      };
    }
  }));

  return {
    from,
    to,
    amount,
    network,
    quoteType: "INDICATIVE_RATE_PREVIEW",
    executionEnabled: false,
    results,
  };
}
