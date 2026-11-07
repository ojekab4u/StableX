export const ASSETS = {
  CAD: {
    code: "CAD", name: "Canadian Dollar", type: "FIAT", issuer: null,
    networks: [], contractAddresses: {}, decimals: 2,
    settlement: "FIAT_RAIL", status: "REGISTERED", region: "GLOBAL",
  },
  NGN: {
    code: "NGN", name: "Nigerian Naira", type: "FIAT", issuer: null,
    networks: [], contractAddresses: {}, decimals: 2,
    settlement: "FIAT_RAIL", status: "REGISTERED", region: "GLOBAL",
  },
  USDC: {
    code: "USDC", name: "USD Coin", type: "STABLECOIN", issuer: "Circle",
    networks: ["BASE", "BASE_SEPOLIA"],
    contractAddresses: {
      BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      BASE_SEPOLIA: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
    decimals: 6, settlement: "ONCHAIN",
    status: "PUBLIC_MAINNET_METADATA_CONFIGURED",
    metadataSource: "https://www.circle.com/multi-chain-usdc/base",
    region: "GLOBAL",
  },
  USDT: {
    code: "USDT", name: "Tether USD", type: "STABLECOIN", issuer: "Tether",
    networks: [], contractAddresses: {}, decimals: null,
    settlement: "ONCHAIN", status: "PENDING_VERIFICATION", region: "GLOBAL",
  },
  CADD: {
    code: "CADD", name: "Canadian Dollar Digital", type: "STABLECOIN",
    issuer: "Tetra Trust Company", networks: ["BASE", "ETHEREUM", "SOLANA", "TEMPO"],
    contractAddresses: {
      BASE: "0x16F93eBC5320C89EfC8701577efe49d14A276a06",
      ETHEREUM: "0x16F93eBC5320C89EfC8701577efe49d14A276a06",
    },
    decimals: 18, settlement: "ONCHAIN",
    status: "NETWORK_SUPPORT_CONFIRMED_ADDRESS_PENDING",
    metadataSource: "https://tetradg.com/frequently-asked-questions",
    solanaAddress: "Az9eyxEaiZD9AX4j5nP19Cm79eyfNriTuddMSQmLNEBm",
  },
  CADC: {
    code: "CADC", name: "Canadian Dollar Coin", type: "STABLECOIN",
    issuer: "CADC Reserve Trust (serviced by Loon Payments)",
    networks: ["BASE"],
    contractAddresses: {
      BASE: "0x5e63E9C06c3F2c779EF29a8071F94F5a724eB5e4",
    },
    decimals: null, settlement: "ONCHAIN",
    status: "PUBLIC_MAINNET_CONTRACT_CONFIGURED",
    metadataSource: "https://loon.finance/cadc/",
    metadataNote: "Use upgraded Base contract; Loon states legacy CADC contracts are being migrated.",
  },
  QCAD: {
    code: "QCAD", name: "QCAD", type: "STABLECOIN", issuer: "To be verified",
    networks: [], contractAddresses: {}, decimals: null,
    settlement: "ONCHAIN", status: "PENDING_VERIFICATION",
  },
  CNGN: {
    code: "CNGN", name: "CNGN", type: "STABLECOIN", issuer: "To be verified",
    networks: [], contractAddresses: {}, decimals: null,
    settlement: "ONCHAIN", status: "PENDING_VERIFICATION",
  },
  EURC: {
    code: "EURC", name: "Euro Coin", type: "STABLECOIN", issuer: "Circle",
    networks: ["BASE_SEPOLIA"],
    contractAddresses: {
      BASE_SEPOLIA: "0x808456652fdb597867f38412077A9182bf77359F",
    },
    decimals: 6, settlement: "ONCHAIN", status: "TESTNET_CONFIGURED",
    region: "GLOBAL",
  },
  GBP: { code: "GBP", name: "British Pound", type: "FIAT", networks: [], contractAddresses: {}, decimals: 2, settlement: "FIAT_RAIL", status: "REGISTERED", region: "GLOBAL" },
  USD: { code: "USD", name: "United States Dollar", type: "FIAT", networks: [], contractAddresses: {}, decimals: 2, settlement: "FIAT_RAIL", status: "REGISTERED", region: "GLOBAL" },
  EUR: { code: "EUR", name: "Euro", type: "FIAT", networks: [], contractAddresses: {}, decimals: 2, settlement: "FIAT_RAIL", status: "REGISTERED", region: "GLOBAL" },
  XAF: { code: "XAF", name: "Central African CFA Franc", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  XOF: { code: "XOF", name: "West African CFA Franc", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  KES: { code: "KES", name: "Kenyan Shilling", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  TZS: { code: "TZS", name: "Tanzanian Shilling", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  UGX: { code: "UGX", name: "Ugandan Shilling", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  GHS: { code: "GHS", name: "Ghanaian Cedi", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  ZAR: { code: "ZAR", name: "South African Rand", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
};

export const getAsset = (code) => ASSETS[String(code).toUpperCase()] ?? null;
export const getAllAssets = () => Object.values(ASSETS);
export const getTradableAssets = () =>
  getAllAssets().filter((asset) => asset.status === "TESTNET_CONFIGURED" || asset.status === "ACTIVE");

// Check if a customer from a given country can hold a wallet for this currency.
// NGN is NG-region (Nigeria-specific); everything else is GLOBAL.
export const canHoldWallet = (assetCode, customerCountry = "GLOBAL") => {
  const asset = getAsset(assetCode);
  if (!asset) return false;
  const region = asset.region || "GLOBAL"; // assets without region default to GLOBAL
  if (region === "GLOBAL") return true;
  if (region === customerCountry) return true;
  return false;
};

export const getWalletEligibleAssets = (customerCountry = "GLOBAL") =>
  getAllAssets().filter((asset) => canHoldWallet(asset.code, customerCountry));

export const getAssetPairs = () => [
  { from: "CAD", to: "USDC", category: "FIAT_TO_STABLECOIN" },
  { from: "USDC", to: "CAD", category: "STABLECOIN_TO_FIAT" },
  { from: "CADD", to: "USDC", category: "STABLECOIN_TO_STABLECOIN" },
  { from: "USDC", to: "CADD", category: "STABLECOIN_TO_STABLECOIN" },
  { from: "CADC", to: "USDC", category: "STABLECOIN_TO_STABLECOIN" },
  { from: "QCAD", to: "USDC", category: "STABLECOIN_TO_STABLECOIN" },
  { from: "NGN", to: "USDC", category: "FIAT_TO_STABLECOIN" },
  { from: "USDC", to: "NGN", category: "STABLECOIN_TO_FIAT" },
];
