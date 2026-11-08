import test from "node:test";
import assert from "node:assert/strict";
import { getPaycrestRate, getPaycrestReadiness } from "../services/providers/paycrestService.js";
import { getHoneycoinRate, getHoneycoinReadiness } from "../services/providers/honeycoinService.js";
import { getBridgeRate, getBridgeReadiness, createBridgeOnRampOrder } from "../services/providers/bridgeService.js";
import { rankRoutingQuotes } from "../services/routingService.js";

test("Paycrest onramp preview requests a one-token indicative rate", async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.PAYCREST_API_BASE_URL;
  process.env.PAYCREST_API_BASE_URL = "https://api.paycrest.io";
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => ({ data: { buy: { rate: "1500" }, sell: { rate: "1490" } } }) };
  };

  try {
    const quote = await getPaycrestRate({ from: "NGN", to: "USDC", amount: 10000, network: "base" });
    assert.match(requestedUrl, /\/v2\/rates\/base\/USDC\/1\/NGN$/);
    assert.equal(quote.direction, "ONRAMP");
    assert.equal(quote.rateRequestTokenAmount, 1);
    assert.equal(quote.executionEnabled, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.PAYCREST_API_BASE_URL;
    else process.env.PAYCREST_API_BASE_URL = originalBase;
  }
});

test("Paycrest offramp preview uses the requested stablecoin amount", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => ({ data: { sell: { rate: "1500" } } }) };
  };

  try {
    const quote = await getPaycrestRate({ from: "USDC", to: "NGN", amount: 25, network: "base" });
    assert.match(requestedUrl, /\/v2\/rates\/base\/USDC\/25\/NGN$/);
    assert.equal(quote.direction, "OFFRAMP");
    assert.equal(quote.rateRequestTokenAmount, 25);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Honeycoin uses the preferred B2B base URL and authenticates server-side", async () => {
  const originalFetch = globalThis.fetch;
  const originals = {
    key: process.env.HONEYCOIN_API_KEY,
    publicKey: process.env.HONEYCOIN_PUBLIC_KEY,
    b2bBase: process.env.HONEYCOIN_B2B_BASE_URL,
    legacyBase: process.env.HONEYCOIN_API_BASE_URL,
  };
  process.env.HONEYCOIN_API_KEY = "test-api-key";
  process.env.HONEYCOIN_PUBLIC_KEY = "test-public-key";
  process.env.HONEYCOIN_B2B_BASE_URL = "https://honeycoin.test/api/sandbox/b2b";
  process.env.HONEYCOIN_API_BASE_URL = "https://legacy-honeycoin.test/api/b2b";
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/auth/generate-bearer-token")) {
      return { ok: true, json: async () => ({ token: "test-bearer", expiresAt: Math.floor(Date.now() / 1000) + 3600 }) };
    }
    return { ok: true, json: async () => ({ data: { rate: "1500", convertedAmount: "15000000" } }) };
  };

  try {
    const quote = await getHoneycoinRate({ from: "NGN", to: "USDC", amount: 10000 });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /^https:\/\/honeycoin\.test\/api\/sandbox\/b2b\/auth/);
    assert.match(calls[1].url, /^https:\/\/honeycoin\.test\/api\/sandbox\/b2b\/utilities/);
    assert.equal(calls[0].options.headers["api-key"], "test-api-key");
    assert.equal(calls[1].options.headers.Authorization, "Bearer test-bearer");
    assert.equal(quote.quoteType, "INDICATIVE_RATE_PREVIEW");
    assert.equal(quote.executionEnabled, false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [
      ["HONEYCOIN_API_KEY", originals.key],
      ["HONEYCOIN_PUBLIC_KEY", originals.publicKey],
      ["HONEYCOIN_B2B_BASE_URL", originals.b2bBase],
      ["HONEYCOIN_API_BASE_URL", originals.legacyBase],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Bridge requests the documented exchange-rate endpoint with Api-Key auth", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BRIDGE_API_KEY;
  const originalBase = process.env.BRIDGE_API_BASE_URL;
  process.env.BRIDGE_API_KEY = "sk-test-bridge";
  process.env.BRIDGE_API_BASE_URL = "https://api.sandbox.bridge.xyz";
  let requestedUrl;
  let requestedOptions;
  globalThis.fetch = async (url, options = {}) => {
    requestedUrl = new URL(String(url));
    requestedOptions = options;
    return {
      ok: true,
      text: async () => JSON.stringify({
        midmarket_rate: "1.000",
        buy_rate: "1.001",
        sell_rate: "0.999",
        updated_at: new Date().toISOString(),
      }),
    };
  };

  try {
    const quote = await getBridgeRate({ from: "USD", to: "USDT", amount: 100 });
    assert.equal(requestedUrl.origin, "https://api.sandbox.bridge.xyz");
    assert.equal(requestedUrl.pathname, "/v0/exchange_rates");
    assert.equal(requestedUrl.searchParams.get("from"), "usd");
    assert.equal(requestedUrl.searchParams.get("to"), "usdt");
    assert.equal(requestedOptions.headers["Api-Key"], "sk-test-bridge");
    assert.equal(requestedOptions.headers.Authorization, undefined);
    assert.equal(quote.quoteType, "INDICATIVE_RATE_PREVIEW");
    assert.equal(quote.rate, 0.999);
    assert.equal(quote.destinationAmount, 99.9);
    assert.equal(quote.executionEnabled, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BRIDGE_API_KEY;
    else process.env.BRIDGE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.BRIDGE_API_BASE_URL;
    else process.env.BRIDGE_API_BASE_URL = originalBase;
  }
});

test("Bridge refuses unsupported pairs and never calls the API for them", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BRIDGE_API_KEY;
  process.env.BRIDGE_API_KEY = "sk-test-bridge";
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("should not be called"); };

  try {
    await assert.rejects(
      getBridgeRate({ from: "NGN", to: "USDC", amount: 1000 }),
      /support USD paired with BRL, COP, EUR, GBP, MXN or USDT/
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BRIDGE_API_KEY;
    else process.env.BRIDGE_API_KEY = originalKey;
  }
});

test("Bridge readiness reports only its implemented indicative-rate capability", () => {
  const originalKey = process.env.BRIDGE_API_KEY;
  process.env.BRIDGE_API_KEY = "";
  try {
    const readiness = getBridgeReadiness();
    assert.equal(readiness.configured, false);
    assert.deepEqual(readiness.capabilities, ["INDICATIVE_FX_RATE_PREVIEW"]);
    assert.equal(readiness.executionEnabled, false);
  } finally {
    if (originalKey === undefined) delete process.env.BRIDGE_API_KEY;
    else process.env.BRIDGE_API_KEY = originalKey;
  }
});

test("Bridge order creation is explicitly disabled rather than calling an unverified endpoint", async () => {
  await assert.rejects(createBridgeOnRampOrder({}), (error) => {
    assert.equal(error.statusCode, 501);
    return /not implemented/.test(error.message);
  });
});

test("routing ranks executable quotes before read-only previews", () => {
  const ranked = rankRoutingQuotes([
    { provider: "Indicative", providerClass: "INDICATIVE", executionEnabled: false, destinationAmount: 999 },
    { provider: "Executable", providerClass: "LIVE", executionEnabled: true, destinationAmount: 1 },
    { provider: "On-chain preview", providerClass: "ONCHAIN", executionEnabled: false, destinationAmount: 2 },
    { provider: "Provider quote preview", providerClass: "LIVE", executionEnabled: false, destinationAmount: 3 },
  ]);
  assert.deepEqual(ranked.map((quote) => quote.provider), [
    "Executable",
    "On-chain preview",
    "Provider quote preview",
    "Indicative",
  ]);
});

test("placeholder credentials are reported as missing", () => {
  const original = {
    honeyKey: process.env.HONEYCOIN_API_KEY,
    honeyPublic: process.env.HONEYCOIN_PUBLIC_KEY,
    paycrestKey: process.env.PAYCREST_API_KEY,
    paycrestSecret: process.env.PAYCREST_API_SECRET,
  };
  process.env.HONEYCOIN_API_KEY = "key";
  process.env.HONEYCOIN_PUBLIC_KEY = "";
  process.env.PAYCREST_API_KEY = "your_api_key";
  process.env.PAYCREST_API_SECRET = "your_api_secret";

  try {
    assert.equal(getHoneycoinReadiness().configured, false);
    assert.equal(getPaycrestReadiness().configured, false);
  } finally {
    for (const [key, value] of [
      ["HONEYCOIN_API_KEY", original.honeyKey],
      ["HONEYCOIN_PUBLIC_KEY", original.honeyPublic],
      ["PAYCREST_API_KEY", original.paycrestKey],
      ["PAYCREST_API_SECRET", original.paycrestSecret],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
