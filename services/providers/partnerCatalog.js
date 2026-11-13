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
    role: "NGN collections (virtual accounts) and payouts",
    corridors: ["NGN"],
    docsUrl: "https://nomba.com/",
    requiredCredentials: ["NOMBA_API_BASE_URL", "NOMBA_API_KEY"],
    requiredWebhooks: true,
    capabilities: ["NGN_COLLECTION", "NGN_PAYOUT"],
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
    role: "CAD/USD crypto trading rail — CAD↔USDC quotes, execution and cross-border settlement",
    corridors: ["CAD", "USD", "USDC"],
    docsUrl: "https://netcoins.com/crypto-api-trading",
    docsNote: "API spec is private; endpoint documentation is provided with the credential package (Bitwarden send). Regulated platform: FINTRAC MSB M15560893, BCSC-registered.",
    requiredCredentials: [
      "NETCOINS_ENVIRONMENT",
      "NETCOINS_API_BASE_URL",
      "NETCOINS_API_KEY",
      "NETCOINS_API_SECRET",
    ],
    capabilities: ["CAD_ONRAMP", "CAD_OFFRAMP", "USD_ONRAMP", "USD_OFFRAMP", "CUSTODY"],
    capabilitiesPlanned: ["LIVE_QUOTE", "ORDER_EXECUTION", "WEBHOOK_STATUS"],
    configurationTasks: [
      "Retrieve staging + production credentials from the Bitwarden sends (account email + 2FA)",
      "Obtain the private API specification (auth scheme, endpoints, rate limits, webhooks)",
      "Confirm the whitelisted public IP matches the machine running StableX (403 'IP Address not whitelisted' otherwise)",
      "Confirm sandbox behaviour: whether staging orders move real funds or are simulated",
    ],
    openQuestions: [
      "Does the staging environment fully simulate funding + settlement?",
      "Are crypto withdrawals to arbitrary Base addresses supported via API?",
    ],
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
    openQuestions: [
      "Confirm whether it is a price source only, not a liquidity provider",
    ],
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
    openQuestions: entry.openQuestions ?? [],
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
