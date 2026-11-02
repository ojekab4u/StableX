


export const ASSETS = {
  CAD: {
    code: "CAD",
    name: "Canadian Dollar",
    type: "FIAT",
    issuer: null,
    networks: [],
    contractAddresses: {},
    decimals: 2,
    settlement: "FIAT_RAIL",
    status: "REGISTERED",
  },

  NGN: {
    code: "NGN",
    name: "Nigerian Naira",
    type: "FIAT",
    issuer: null,
    networks: [],
    contractAddresses: {},
    decimals: 2,
    settlement: "FIAT_RAIL",
    status: "REGISTERED",
  },

  USDC: {
    code: "USDC",
    name: "USD Coin",
    type: "STABLECOIN",
    issuer: "Circle",
    networks: ["BASE", "BASE_SEPOLIA"],
    contractAddresses: {
      BASE: null,
      BASE_SEPOLIA: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
    decimals: 6,
    settlement: "ONCHAIN",
    status: "TESTNET_CONFIGURED",
  },

  USDT: {
    code: "USDT",
    name: "Tether USD",
    type: "STABLECOIN",
    issuer: "Tether",
    networks: [],
    contractAddresses: {},
    decimals: 6,
    settlement: "ONCHAIN",
    status: "PENDING_VERIFICATION",
  },

  CADD: {
    code: "CADD",
    name: "Canadian Dollar Digital",
    type: "STABLECOIN",
    issuer: "Tetra Trust",
    networks: [],
    contractAddresses: {},
    decimals: null,
    settlement: "ONCHAIN",
    status: "PENDING_VERIFICATION",
  },

  CADC: {
    code: "CADC",
    name: "Canadian Dollar Coin",
    type: "STABLECOIN",
    issuer: "Loon",
    networks: [],
    contractAddresses: {},
    decimals: null,
    settlement: "ONCHAIN",
    status: "PENDING_VERIFICATION",
  },

  QCAD: {
    code: "QCAD",
    name: "QCAD",
    type: "STABLECOIN",
    issuer: "To be verified",
    networks: [],
    contractAddresses: {},
    decimals: null,
    settlement: "ONCHAIN",
    status: "PENDING_VERIFICATION",
  },

  CNGN: {
    code: "CNGN",
    name: "CNGN",
    type: "STABLECOIN",
    issuer: "To be verified",
    networks: [],
    contractAddresses: {},
    decimals: null,
    settlement: "ONCHAIN",
    status: "PENDING_VERIFICATION",
  },

  EURC: {
    code: "EURC",
    name: "Euro Coin",
    type: "STABLECOIN",
    issuer: "Circle",
    networks: ["BASE_SEPOLIA"],
    contractAddresses: {
      BASE_SEPOLIA: "0x808456652fdb597867f38412077A9182bf77359F",
    },
    decimals: 6,
    settlement: "ONCHAIN",
    status: "TESTNET_CONFIGURED",
  },

  GBP: {
    code: "GBP",
    name: "British Pound",
    type: "FIAT",
    issuer: null,
    networks: [],
    contractAddresses: {},
    decimals: 2,
    settlement: "FIAT_RAIL",
    status: "REGISTERED",
  },

  XAF: { code: "XAF", name: "Central African CFA Franc", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  KES: { code: "KES", name: "Kenyan Shilling", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  TZS: { code: "TZS", name: "Tanzanian Shilling", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  UGX: { code: "UGX", name: "Ugandan Shilling", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  GHS: { code: "GHS", name: "Ghanaian Cedi", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
  ZAR: { code: "ZAR", name: "South African Rand", type: "FIAT", settlement: "FIAT_RAIL", status: "REGISTERED" },
};

export const getAsset = (code) =>
  ASSETS[String(code).toUpperCase()] ?? null;

export const getAllAssets = () =>
  Object.values(ASSETS);

export const getTradableAssets = () =>
  getAllAssets().filter(
    (asset) => asset.status === "TESTNET_CONFIGURED" ||
               asset.status === "ACTIVE"
  );

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
