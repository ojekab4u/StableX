const hasValue = (name) => Boolean(String(process.env[name] || "").trim());

function integration(name, requiredVariables, description) {
  const missing = requiredVariables.filter((variable) => !hasValue(variable));
  return {
    name,
    description,
    configured: missing.length === 0,
    status: missing.length === 0 ? "CONFIGURED_NOT_CONNECTION_TESTED" : "AWAITING_CONFIGURATION",
    missingVariables: missing,
  };
}

export function getIntegrationReadiness() {
  const kyc = integration(
    "KYC / KYB provider",
    ["KYC_API_BASE_URL", "KYC_API_KEY"],
    "Identity and business verification. Variable names are StableX placeholders pending the assessor's provider documentation."
  );

  const liquidity = integration(
    "Liquidity provider",
    ["LIQUIDITY_API_BASE_URL", "LIQUIDITY_API_KEY"],
    "Asset availability, executable quotes, fees, quote expiry and swap/acquisition."
  );

  const payout = integration(
    "Financial institution",
    ["PAYOUT_API_BASE_URL", "PAYOUT_API_KEY"],
    "Beneficiary validation, fiat payout initiation, status checks and webhooks."
  );

  const base = {
    name: "Base network settlement",
    rpcConfigured: hasValue("BASE_RPC_URL"),
    mainnetUsdcContractConfigured: hasValue("BASE_USDC_CONTRACT_ADDRESS"),
    status: hasValue("BASE_RPC_URL") && hasValue("BASE_USDC_CONTRACT_ADDRESS")
      ? "CONFIGURED_NOT_CONNECTION_TESTED"
      : "PARTIALLY_CONFIGURED",
    missingVariables: [
      ...(!hasValue("BASE_RPC_URL") ? ["BASE_RPC_URL"] : []),
      ...(!hasValue("BASE_USDC_CONTRACT_ADDRESS") ? ["BASE_USDC_CONTRACT_ADDRESS"] : []),
    ],
    warning: "An RPC endpoint alone does not establish token support or liquidity. Verify chain ID, issuer, contract address and decimals before enabling transfers.",
  };

  const integrations = [kyc, liquidity, base, payout];
  return {
    mode: "INTEGRATION_PREPARATION",
    executionEnabled: false,
    readyForLiveTransfers: false,
    integrations,
    blockers: integrations
      .filter((item) => item.status !== "CONFIGURED_NOT_CONNECTION_TESTED")
      .map((item) => item.name),
    note: "Configured means required environment variables are present only. This endpoint does not authenticate with providers or test their APIs.",
  };
}
