import test from "node:test";
import assert from "node:assert/strict";
import { getPaycrestRate, getPaycrestReadiness } from "../services/providers/paycrestService.js";
import { getHoneycoinRate, getHoneycoinReadiness } from "../services/providers/honeycoinService.js";
import { getBridgeRate, getBridgeReadiness, createBridgeOnRampOrder } from "../services/providers/bridgeService.js";
import { getNetcoinsRate, getNetcoinsReadiness } from "../services/providers/netcoinsService.js";
import { rankRoutingQuotes, normalizeProviderResult } from "../services/routingService.js";

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

test("Bridge readiness reports implemented preview and customer onboarding capabilities", () => {
  const originalKey = process.env.BRIDGE_API_KEY;
  process.env.BRIDGE_API_KEY = "";
  try {
    const readiness = getBridgeReadiness();
    assert.equal(readiness.configured, false);
    assert.deepEqual(readiness.capabilities, [
      "INDICATIVE_FX_RATE_PREVIEW",
      "CUSTOMER_LOOKUP",
      "CUSTOMER_CREATION_AFTER_COMPLIANCE_AND_TOS",
    ]);
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


test("Honeycoin creates an NGN to Base USDC on-ramp and supports canonical status lookup", async () => {
  const originalFetch = globalThis.fetch;
  const originals = {
    key: process.env.HONEYCOIN_API_KEY,
    publicKey: process.env.HONEYCOIN_PUBLIC_KEY,
    b2bBase: process.env.HONEYCOIN_B2B_BASE_URL,
    cryptoBase: process.env.HONEYCOIN_CRYPTO_BASE_URL,
    environment: process.env.HONEYCOIN_ENVIRONMENT,
  };
  process.env.HONEYCOIN_API_KEY = "unit-test-api-key";
  process.env.HONEYCOIN_PUBLIC_KEY = "unit-test-public-key";
  process.env.HONEYCOIN_B2B_BASE_URL = "https://honeycoin.test/api/sandbox/b2b";
  process.env.HONEYCOIN_CRYPTO_BASE_URL = "https://honeycoin.test/api/sandbox";
  process.env.HONEYCOIN_ENVIRONMENT = "Sandbox";
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/auth/generate-bearer-token")) {
      return { ok: true, json: async () => ({ token: "unit-test-bearer", expiresAt: Math.floor(Date.now() / 1000) + 3600 }) };
    }
    if (String(url).endsWith("/minting/onramp")) {
      return { ok: true, json: async () => ({
        success: true,
        data: { transactionId: "sandbox_transaction_123", stepRequired: "redirect", redirectUrl: "https://checkout.example.test/continue" },
      }) };
    }
    if (String(url).endsWith("/transactions/sandbox_transaction_123")) {
      return { ok: true, json: async () => ({
        success: true,
        data: { transactionId: "sandbox_transaction_123", status: "PENDING", chargeStatus: "pending", externalReference: "stablex-transfer" },
      }) };
    }
    throw new Error("Unexpected Honeycoin URL: " + String(url));
  };

  try {
    const { createHoneycoinOnrampOrder, getHoneycoinTransaction } = await import("../services/providers/honeycoinService.js");
    const order = await createHoneycoinOnrampOrder({
      senderAmount: 111,
      senderCurrency: "NGN",
      receiverCurrency: "USDC",
      chain: "BASE",
      receiverAddress: "0x0000000000000000000000000000000000000001",
      method: "opay",
      email: "customer@example.test",
      externalReference: "stablex-transfer",
    });
    assert.equal(order.transactionId, "sandbox_transaction_123");
    assert.equal(order.stepRequired, "redirect");
    const createCall = calls.find((call) => call.url.endsWith("/minting/onramp"));
    assert.ok(createCall);
    assert.equal(createCall.url, "https://honeycoin.test/api/sandbox/minting/onramp");
    const body = JSON.parse(createCall.options.body);
    assert.equal(body.senderAmount, 111);
    assert.equal(body.senderCurrency, "NGN");
    assert.equal(body.receiverCurrency, "USDC");
    assert.equal(body.chain, "BASE");
    assert.equal(body.method, "opay");
    assert.equal(body.chargeDetails.email, "customer@example.test");
    assert.equal(body.externalReference, "stablex-transfer");

    const status = await getHoneycoinTransaction("sandbox_transaction_123");
    assert.equal(status.chargeStatus, "pending");
    assert.ok(calls.some((call) => call.url === "https://honeycoin.test/api/sandbox/b2b/transactions/sandbox_transaction_123"));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      HONEYCOIN_API_KEY: originals.key,
      HONEYCOIN_PUBLIC_KEY: originals.publicKey,
      HONEYCOIN_B2B_BASE_URL: originals.b2bBase,
      HONEYCOIN_CRYPTO_BASE_URL: originals.cryptoBase,
      HONEYCOIN_ENVIRONMENT: originals.environment,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test("Paytrie quote normalization preserves fee breakdown and calculates a clearly labelled pricing-rule estimate", () => {
  const quote = normalizeProviderResult("Paytrie", {
    from: "CAD", to: "USDC", amount: 10, customerId: "customer-1",
  }, {
    quoteType: "LIVE_PROVIDER_QUOTE",
    raw: {
      quoteId: 12345,
      leftSideLabel: "CAD",
      leftSideValue: 10,
      rightSideLabel: "USDC-BASE",
      rightSideValue: 3.52,
      breakdown: { paytrieFee: 5, gasFee: 0.6, usdToCad: 1.42 },
    },
  });

  assert.equal(quote.destinationAmount, 3.52);
  assert.equal(quote.fee, 5);
  assert.equal(quote.feeCurrency, null, "Do not invent a fee currency when Paytrie omits it");
  assert.deepEqual(quote.feeBreakdown, { paytrieFee: 5, gasFee: 0.6, usdToCad: 1.42 });
  assert.equal(quote.providerData.quoteId, 12345);
  assert.equal(quote.pricingPolicy.feeRateBps, 60);
  assert.equal(quote.pricingPolicy.percentageFee, 0.06);
  assert.equal(quote.pricingPolicy.estimatedFee, 5);
  assert.equal(quote.pricingPolicy.estimatedNetSourceAmount, 5);
  assert.equal(quote.pricingPolicy.minimumFeeApplies, true);
  assert.equal(quote.pricingPolicy.estimateOnly, true);
});

test("Paytrie pricing-rule estimate switches from the minimum to 60 bps when percentage fee is higher", () => {
  const quote = normalizeProviderResult("Paytrie", {
    from: "CAD", to: "USDC", amount: 1000,
  }, {
    quoteType: "LIVE_PROVIDER_QUOTE",
    raw: {
      quoteId: 12346,
      leftSideLabel: "CAD",
      leftSideValue: 1000,
      rightSideLabel: "USDC-BASE",
      rightSideValue: 700,
      breakdown: { paytrieFee: 6, gasFee: 0.2, usdToCad: 1.4 },
    },
  });

  assert.equal(quote.pricingPolicy.percentageFee, 6);
  assert.equal(quote.pricingPolicy.estimatedFee, 6);
  assert.equal(quote.pricingPolicy.estimatedNetSourceAmount, 994);
  assert.equal(quote.pricingPolicy.minimumFeeApplies, false);
});

test("Netcoins buy preview uses the account-priced indicative buy price", async () => {
  const originalFetch = globalThis.fetch;
  const originals = {
    key: process.env.NETCOINS_API_KEY,
    base: process.env.NETCOINS_API_BASE_URL,
    environment: process.env.NETCOINS_ENVIRONMENT,
  };
  process.env.NETCOINS_API_KEY = "test-netcoins-token";
  process.env.NETCOINS_ENVIRONMENT = "staging";
  delete process.env.NETCOINS_API_BASE_URL;
  let requestedUrl = "";
  let requestInit = null;
  globalThis.fetch = async (url, init) => {
    requestedUrl = String(url);
    requestInit = init;
    return {
      ok: true,
      json: async () => ({
        data: {
          base_currency: "USDC",
          quote_currency: "CAD",
          buy_price: "1.43",
          sell_price: "1.41",
          timestamp: "2026-11-13T10:30:00.000000Z",
        },
      }),
    };
  };

  try {
    const quote = await getNetcoinsRate({ from: "CAD", to: "USDC", amount: 100 });
    assert.match(requestedUrl, /^https:\/\/api-staging\.netcoins\.app\/api\/v4\/markets\/prices\/USDC\/CAD$/);
    assert.equal(requestInit.method, "GET");
    assert.equal(requestInit.headers.Authorization, "Bearer test-netcoins-token");
    assert.equal(quote.direction, "ONRAMP");
    assert.equal(quote.destinationAmount, 100 / 1.43);
    assert.equal(quote.rate, 1.43);
    assert.equal(quote.buyPrice, 1.43);
    assert.equal(quote.sellPrice, 1.41);
    assert.equal(quote.executionEnabled, false);
    assert.equal(quote.priceTimestamp, "2026-11-13T10:30:00.000000Z");
  } finally {
    globalThis.fetch = originalFetch;
    if (originals.key === undefined) delete process.env.NETCOINS_API_KEY; else process.env.NETCOINS_API_KEY = originals.key;
    if (originals.base === undefined) delete process.env.NETCOINS_API_BASE_URL; else process.env.NETCOINS_API_BASE_URL = originals.base;
    if (originals.environment === undefined) delete process.env.NETCOINS_ENVIRONMENT; else process.env.NETCOINS_ENVIRONMENT = originals.environment;
  }
});

test("Netcoins sell preview uses the account-priced indicative sell price", async () => {
  const originalFetch = globalThis.fetch;
  process.env.NETCOINS_API_KEY = "test-netcoins-token";
  process.env.NETCOINS_API_BASE_URL = "https://netcoins.test/api/v4";
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        data: {
          base_currency: "USDC",
          quote_currency: "CAD",
          buy_price: "1.43",
          sell_price: "1.415",
          timestamp: "2026-11-13T10:30:00.000000Z",
        },
      }),
    };
  };

  try {
    const quote = await getNetcoinsRate({ from: "USDC", to: "CAD", amount: 50 });
    assert.equal(requestedUrl, "https://netcoins.test/api/v4/markets/prices/USDC/CAD");
    assert.equal(quote.direction, "OFFRAMP");
    assert.equal(quote.destinationAmount, 50 * 1.415);
    assert.equal(quote.rate, 1.415);
    assert.equal(quote.quoteType, "INDICATIVE_RATE_PREVIEW");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("Netcoins rejects crypto-to-crypto and fiat-to-fiat requests without calling the API", async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  process.env.NETCOINS_API_KEY = "test-netcoins-token";
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };

  try {
    await assert.rejects(
      () => getNetcoinsRate({ from: "USDC", to: "USDT", amount: 10 }),
      (error) => error.statusCode === 400 && /Netcoins quotes/i.test(error.message)
    );
    await assert.rejects(
      () => getNetcoinsRate({ from: "CAD", to: "USD", amount: 10 }),
      (error) => error.statusCode === 400 && /crypto asset/i.test(error.message)
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Netcoins readiness reports missing credentials and staging default", async () => {
  const originalKey = process.env.NETCOINS_API_KEY;
  const originalEnvironment = process.env.NETCOINS_ENVIRONMENT;
  delete process.env.NETCOINS_API_KEY;
  delete process.env.NETCOINS_ENVIRONMENT;

  try {
    const readiness = getNetcoinsReadiness();
    assert.equal(readiness.name, "Netcoins");
    assert.equal(readiness.configured, false);
    assert.deepEqual(readiness.missingVariables, ["NETCOINS_API_KEY"]);
    assert.equal(readiness.environment, "staging");
    assert.equal(readiness.executionEnabled, false);
  } finally {
    if (originalKey === undefined) delete process.env.NETCOINS_API_KEY; else process.env.NETCOINS_API_KEY = originalKey;
    if (originalEnvironment === undefined) delete process.env.NETCOINS_ENVIRONMENT; else process.env.NETCOINS_ENVIRONMENT = originalEnvironment;
  }
});
