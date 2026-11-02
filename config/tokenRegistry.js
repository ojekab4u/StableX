

export const BASE_SEPOLIA_TOKENS = Object.freeze([
  {
    id: 'circle-usdc-base-sepolia',
    name: 'USD Coin',
    expectedSymbol: 'USDC',
    issuer: 'Circle',
    assetType: 'stablecoin',
    network: 'Base Sepolia',
    chainId: 84532,
    contractAddress:
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    decimals: 6,
    environment: 'testnet',
  },

  {
    id: 'circle-eurc-base-sepolia',
    name: 'Euro Coin',
    expectedSymbol: 'EURC',
    issuer: 'Circle',
    assetType: 'stablecoin',
    network: 'Base Sepolia',
    chainId: 84532,
    contractAddress:
      '0x808456652fdb597867f38412077A9182bf77359F',
    decimals: 6,
    environment: 'testnet',
  },
]);
