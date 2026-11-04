import test from "node:test";
import assert from "node:assert/strict";
import { getPaycrestRate, getPaycrestReadiness } from "../services/providers/paycrestService.js";
import { getHoneycoinRate, getHoneycoinReadiness } from "../services/providers/honeycoinService.js";

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

test("Honeycoin obtains a bearer token server-side before requesting FX rates", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HONEYCOIN_API_KEY;
  const originalPublic = process.env.HONEYCOIN_PUBLIC_KEY;
  const originalBase = process.env.HONEYCOIN_API_BASE_URL;
  process.env.HONEYCOIN_API_KEY = "test-api-key";
  process.env.HONEYCOIN_PUBLIC_KEY = "test-public-key";
  process.env.HONEYCOIN_API_BASE_URL = "https://honeycoin.test/api/b2b";
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
    assert.equal(calls[0].options.headers["api-key"], "test-api-key");
    assert.equal(calls[1].options.headers.Authorization, "Bearer test-bearer");
    assert.equal(quote.quoteType, "INDICATIVE_RATE_PREVIEW");
    assert.equal(quote.executionEnabled, false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [["HONEYCOIN_API_KEY", originalKey], ["HONEYCOIN_PUBLIC_KEY", originalPublic], ["HONEYCOIN_API_BASE_URL", originalBase]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
