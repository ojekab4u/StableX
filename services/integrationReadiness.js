import { getAsset } from "../config/assets.js";

const hasValue = (name) => Boolean(String(process.env[name] || "").trim());

function integration(name, requiredVariables, description) {
  const missing = requiredVariables.filter((variable) => !hasValue(variable));
  return {
    name,
    description,
    configured: missing.length === 0,
    status: missing.length === 0 ? "CONFIGURED_NOT_CONNECTION_TESTED" : "AWAITING_PROVIDER_CONFIGURATION",
    missingVariables: missing,
  };
}

export function getIntegrationReadiness() {
  const kyc = integration(
    "KYC / KYB provider",
    ["KYC_API_BASE_URL", "KYC_API_KEY"],
    "Provider API configuration is not present. These environment variable names are StableX placeholders, not provider-specific requirements."
  );

  const liquidity = integration(
    "Liquidity provider",
    ["LIQUIDITY_API_BASE_URL", "LIQUIDITY_API_KEY"],
    "Provider API configuration is not present. Required operations include availability, executable quotes and asset acquisition."
  );

  const payout = integration(
    "Financial institution payout",
    ["PAYOUT_API_BASE_URL", "PAYOUT_API_KEY"],
    "Provider API configuration is not present. Required operations include beneficiary validation, payout initiation and settlement status."
  );

  const usdc = getAsset("USDC");
  const baseRpcConfigured = hasValue("BASE_RPC_URL");
  const baseUsdcContractConfigured = Boolean(usdc?.contractAddresses?.BASE);
  const base = {
    name: "Base Mainnet",
    chainId: 8453,
    rpcConfigured: baseRpcConfigured,
    mainnetUsdcContractConfigured: baseUsdcContractConfigured,
    status: baseRpcConfigured && baseUsdcContractConfigured
      ? "RPC_AND_PUBLIC_USDC_METADATA_PRESENT"
      : baseRpcConfigured
        ? "RPC_CONFIGURED_TOKEN_METADATA_PRESENT"
        : "PUBLIC_USDC_METADATA_PRESENT_RPC_CONFIGURATION_OPTIONAL",
    missingVariables: baseRpcConfigured ? [] : ["BASE_RPC_URL"],
    note: "Base Mainnet (chain ID 8453) is the target network. Native USDC contract metadata is sourced from Circle. RPC configuration is separate from provider liquidity and does not enable transfers.",
  };

  const integrations = [kyc, liquidity, base, payout];
  return {
    mode: "INTEGRATION_PREPARATION",
    executionEnabled: false,
    readyForLiveTransfers: false,
    integrations,
    blockers: integrations
      .filter((item) => ["AWAITING_PROVIDER_CONFIGURATION", "PARTIALLY_CONFIGURED"].includes(item.status))
      .map((item) => item.name),
    note: "This is a configuration overview, not a live connection test. Provider environment variable names are StableX placeholders. Public token metadata does not confirm partner approval, liquidity or transfer capability.",
  };
}
