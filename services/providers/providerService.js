import { getHoneycoinRate, getHoneycoinReadiness } from "./honeycoinService.js";
import { getPaycrestRate, getPaycrestReadiness } from "./paycrestService.js";
import { getPaytrieQuote, getPaytrieReadiness } from "../paytrieService.js";
import { getBridgeRate, getBridgeReadiness } from "./bridgeService.js";
import { getPartnerReadiness } from "./partnerCatalog.js";
import { getAerodromeReadiness } from "./aerodromeService.js";

export function getProviderReadiness() {
  return {
    mode: "PROVIDER_ADAPTER_PREPARATION",
    executionEnabled: false,
    providers: [
      getPaytrieReadiness(),
      getHoneycoinReadiness(),
      getPaycrestReadiness(),
      getBridgeReadiness(),
      getAerodromeReadiness(),
    ],
    partners: getPartnerReadiness(),
    note: "Configuration presence is not a successful connection test, provider approval, live liquidity confirmation or permission to move funds.",
  };
}

export async function getProviderRatePreviews({ from, to, amount, network = "base", provider = "all" }) {
  const selected = String(provider || "all").toLowerCase();
  const tasks = [];

  if (selected === "all" || selected === "honeycoin") {
    tasks.push(["Honeycoin", () => getHoneycoinRate({ from, to, amount })]);
  }
  if (selected === "all" || selected === "paycrest") {
    tasks.push(["Paycrest", () => getPaycrestRate({ from, to, amount, network })]);
  }
  if (selected === "all" || selected === "paytrie") {
    tasks.push(["Paytrie", () => getPaytrieQuote({ from, to, amount })]);
  }
  if (selected === "all" || selected === "bridge") {
    tasks.push(["Bridge", () => getBridgeRate({ from, to, amount })]);
  }
  if (!tasks.length) {
    const error = new Error("Provider must be honeycoin, paycrest, paytrie, bridge, or all.");
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
