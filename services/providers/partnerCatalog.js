// Partner catalog — readiness skeletons for every provider on the StableX
// integration map that does not yet have a full adapter. Each entry documents
// the expected configuration variables, the corridor/product role it unlocks,
// and its connector status. No network calls are made until each provider's
// real credentials arrive and its adapter is implemented.
//
// Pattern parity: full adapters (Vove, Paytrie, Honeycoin, Paycrest) already
// live adjacent in services/. When a partner below receives credentials,
// convert its entry into a full adapter following the same shape.

const isUsableCredential = (value) =>
  Boolean(value) && !/^(key|your[_ -].*|replace[_ -].*|changeme|placeholder|test)$/i.test(String(value).trim());

// Definition list; readiness below reads from both config_registry entries.
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
    name: "Bridge (Stripe)",
    role: "USD / GBP / EUR stablecoin issuance and on/off-ramp",
    corridors: ["USD", "GBP", "EUR"],
    docsUrl: "https://bridge.xyz/",
    requiredCredentials: ["BRIDGE_API_BASE_URL", "BRIDGE_API_KEY"],
    capabilities: ["USD_ONOFFRAMP", "GBP_ONOFFRAMP", "EUR_ONOFFRAMP", "STABLECOIN_ISSUANCE"],
    openQuestions: [
      "Whether customer verification flows through Bridge KYC or StableX Vove KYC",
      "Division of responsibility with Circle for USD/USDC conversion",
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
    note: "These partners are catalogued but not yet connected. When credentials arrive, each catalog entry becomes a full adapter following the existing Honeycoin/Paycrest pattern.",
    friendly: PARTNER_CATALOG.map(catalogReadiness),
  };
}
