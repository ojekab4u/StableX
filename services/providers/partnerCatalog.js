// Partner catalog — readiness skeletons for providers without a complete adapter.
// Each entry documents its current verified integration role and remaining work.

const isUsableCredential = (value) =>
  Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder|test)$/i.test(String(value).trim());

export const PARTNER_CATALOG = [
  {
    name: "Apaylo",
    role: "CAD fiat collection and settlement rail",
    corridors: ["CAD"],
    docsUrl: "https://apaylo.com/",
    requiredCredentials: ["APAYLO_API_BASE_URL", "APAYLO_API_KEY"],
    capabilities: ["CAD_COLLECTION", "CAD_PAYOUT"],
    capabilitiesPlanned: ["CAD_RATE_QUOTES"],
  },
  {
    name: "Tetra Trust",
    role: "CADD stablecoin mint / redeem and custody",
    corridors: ["CADD"],
    docsUrl: "https://tetradg.com/cadd",
    requiredCredentials: ["TETRA_API_BASE_URL", "TETRA_API_KEY"],
    capabilities: ["CADD_MINT_REDEEM", "CUSTODY"],
    capabilitiesPlanned: ["CADD_CONTRACT_ADDRESS_VERIFICATION"],
    configurationTasks: [
      "Obtain CADD contract addresses for BASE/ETHEREUM/SOLANA/TEMPO listed in config/assets.js",
    ],
  },
  {
    name: "Nomba",
    role: "Nigeria-native local rails (NGN virtual accounts, collections, bank payouts) plus the cross-border Global Payout API (BANK, MobileMoney, INTERAC, FASTER_PAYMENTS, SEPA, ACH, WIRE) with multi-currency wallets (CAD, USD)",
    corridors: ["NGN", "CAD", "USD", "GHS", "KES", "XAF", "XOF"],
    docsUrl: "https://developer.nomba.com/",
    docsNote:
      "OAuth2 client-credentials: POST /v1/auth/token/issue with client_id + client_secret and an `accountId` header; tokens expire after ~30 minutes and refresh via /v1/auth/token/refresh. " +
      "Sandbox (https://sandbox.nomba.com) accepts requests without credentials. Global Payout supports INTERAC (CAD) — candidate for the CAD fiat leg.",
    requiredCredentials: [
      "NOMBA_API_BASE_URL",
      "NOMBA_CLIENT_ID",
      "NOMBA_CLIENT_SECRET",
      "NOMBA_ACCOUNT_ID",
      "NOMBA_WEBHOOK_SECRET",
    ],
    requiredWebhooks: true,
    capabilities: ["NGN_COLLECTION", "NGN_PAYOUT", "GLOBAL_PAYOUT", "MULTI_CURRENCY_WALLETS", "CAD_PAYOUT_INTERAC"],
    capabilitiesPlanned: ["DRC_MOBILE_MONEY_COLLECTIONS"],
    configurationTasks: [
      "Map Global Payout endpoints (payment methods, authorize transfer, convert money, fetch accounts) into the adapter",
      "Configure the webhook secret once dashboard access is recovered",
    ],
  },
  {
    name: "Fincra",
    role: "NGN payouts plus multi-country fiat coverage",
    corridors: ["NGN", "GHS", "KES", "UGX", "XAF", "XOF", "ZAR"],
    docsUrl: "https://fincra.com/",
    requiredCredentials: ["FINCRA_API_BASE_URL", "FINCRA_API_KEY"],
    requiredWebhooks: true,
    capabilities: ["FIAT_COLLECTION", "FIAT_PAYOUT"],
    capabilitiesPlanned: ["CORRIDOR_CONFIRMATION_FROM_PROVIDER"],
  },
  {
    name: "Strails",
    role: "CNGN naira stablecoin mint / redeem",
    corridors: ["CNGN"],
    docsUrl: "https://strails.co",
    docsNote: "No public documentation site confirmed; verify the official domain.",
    requiredCredentials: ["STRAILS_API_BASE_URL", "STRAILS_API_KEY"],
    capabilities: ["CNGN_MINT_REDEEM"],
    configurationTasks: [
      "Obtain CNGN contract addresses and issuer details for config/assets.js",
      "Confirm official documentation domain",
    ],
  },
  {
    name: "Netcoins",
    role: "CAD/USD crypto trading rail — USDC quotes, instant/limit trades and balances (Netcoins API v4)",
    corridors: ["CAD", "USD", "USDC"],
    docsUrl: "https://developers.netcoins.app/",
    docsNote: "Netcoins API v4 (Trading & Balances): bearer-token auth, `data` envelope, RFQ quote sessions (quoteReqId → quoteId → execute). Staging https://api-staging.netcoins.app/api/v4, production https://api.netcoins.com/api/v4. Rate limits per token. Regulated: FINTRAC MSB M15560893, BCSC.",
    requiredCredentials: [
      "NETCOINS_ENVIRONMENT",
      "NETCOINS_API_KEY",
    ],
    capabilities: ["CAD_ONRAMP", "CAD_OFFRAMP", "USD_ONRAMP", "USD_OFFRAMP", "CUSTODY"],
    capabilitiesPlanned: ["LIVE_QUOTE", "INSTANT_TRADE_EXECUTION", "LIMIT_ORDERS", "PUSHER_WEBSOCKET_QUOTES"],
    configurationTasks: [
      "Whitelist the integration machine IP with Netcoins (staging 403s until confirmed)",
      "Set NETCOINS_ENVIRONMENT=staging with the staging token",
      "v4 documents no withdrawal/deposit endpoints — funding and settlement happen on the Netcoins side",
    ],
  },
  {
    name: "Linkio",
    role: "Primary global FX engine — B2B fiat↔stablecoin ramps across 25 fiat currencies plus retail Direct FX (NGN/USD, Interac corridor), settling to USDC/USDT on Base, Ethereum, BSC, Polygon, Solana and Stellar",
    corridors: [
      "USD", "EUR", "GBP", "NGN", "GHS", "KES", "UGX", "TZS", "XAF", "XOF",
      "MAD", "EGP", "AOA", "BIF", "CDF", "DZD", "ETB", "LYD", "MUR", "MWK",
      "MZN", "SGD", "SLE", "SSP", "TRY", "AED", "USDC", "USDT",
    ],
    docsUrl: "https://docs.linkio.world/",
    docsNote:
      "One `ngnc-sec-key` header authenticates both the Retail and B2B APIs. B2B fiat enum has no CAD (CAD is a Retail/Direct-FX corridor). " +
      "USDC networks: ETHEREUM, BSC, POLYGON, BASE, SOLANA, STELLAR; USDT: TRON, POLYGON, SOLANA. B2B onramp settlement details arrive via the banking_details_received webhook. " +
      "Fees are baked into the rate (~0.5% B2B markup). Regulated: FINTRAC MSB N300000211, US FinCEN MSB 31000339351347.",
    requiredCredentials: ["LINKIO_SECRET_KEY", "LINKIO_API_BASE_URL"],
    capabilities: ["FIAT_ONRAMP", "FIAT_OFFRAMP", "FX_RATE_QUOTES", "CROSS_BORDER_PAYOUTS", "TRANSACTION_STATUS"],
    capabilitiesPlanned: ["VIRTUAL_ACCOUNTS", "PREFUNDED_BUSINESS_WALLET", "LIQUIDATION_ADDRESSES"],
    configurationTasks: [
      "Configure the banking_details_received webhook before enabling B2B onramp execution",
      "Verify per-currency minimums/maximums for every corridor we enable",
    ],
  },
  {
    name: "Quidax",
    role: "DISQUALIFIED — not to be integrated",
    corridors: [],
    docsUrl: "https://ramp-merchant.quidax.io/",
    lifecycleStatus: "DISQUALIFIED",
    lifecycleNote:
      "NGN-concentrated ramp; duplicates Linkio's scope without its multi-currency breadth or payout infrastructure.",
    requiredCredentials: [],
    capabilities: [],
  },
  {
    name: "Honeycoin",
    role: "Temporary fallback and sandbox test corridor only — demoted from primary scaling engine",
    corridors: ["NGN"],
    docsUrl: "https://b2b.honeycoin.app/",
    lifecycleStatus: "FALLBACK",
    lifecycleNote:
      "Backup corridor and sandbox test fixture only; local rails go through Nomba, global FX through Linkio.",
    requiredCredentials: [],
    capabilities: ["NGN_ONRAMP_TEST_CORRIDOR"],
  },
  {
    name: "Circle",
    role: "USDC mint / redemption and programmatic wallet infrastructure",
    corridors: ["USD", "USDC"],
    docsUrl: "https://www.circle.com/",
    requiredCredentials: ["CIRCLE_API_BASE_URL", "CIRCLE_API_KEY"],
    capabilities: ["USDC_MINT", "USDC_REDEMPTION", "WALLET_INFRASTRUCTURE"],
    configurationTasks: [
      "Base USDC mainnet contract already verified in config/assets.js",
    ],
  },
  {
    name: "CoinGecko",
    role: "Reference price feed for the routing engine (role pending confirmation)",
    corridors: [],
    docsUrl: "https://www.coingecko.com/",
    requiredCredentials: ["COINGECKO_API_BASE_URL", "COINGECKO_API_KEY"],
    capabilities: ["REFERENCE_PRICES"],
  },
];

function catalogReadiness(entry) {
  const missing = [];
  for (const variable of entry.requiredCredentials) {
    const value = String(process.env[variable] || "").trim();
    if (!isUsableCredential(value)) missing.push(variable);
  }
  return {
    name: entry.name,
    role: entry.role,
    corridors: entry.corridors,
    docsUrl: entry.docsUrl,
    docsNote: entry.docsNote ?? null,
    lifecycleStatus: entry.lifecycleStatus ?? "ACTIVE",
    lifecycleNote: entry.lifecycleNote ?? null,
    configured: missing.length === 0,
    missingVariables: missing,
    status: missing.length === 0
      ? "CREDENTIALS_PRESENT_NOT_CONNECTION_TESTED"
      : "DOCUMENTED_AWAITING_CREDENTIALS",
    capabilitiesImplemented: [],
    capabilities: entry.capabilities,
    capabilitiesPlanned: entry.capabilitiesPlanned ?? [],
    requiredWebhooks: Boolean(entry.requiredWebhooks),
    configurationTasks: entry.configurationTasks ?? [],
  };
}

export function getPartnerReadiness() {
  return {
    module: "PARTNER_CONNECTOR_SKELETONS",
    connectorsBuilt: 0,
    note: "These partner entries are not executable adapters. Implemented provider adapters are reported separately.",
    friendly: PARTNER_CATALOG.map(catalogReadiness),
  };
}
