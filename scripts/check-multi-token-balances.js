


import 'dotenv/config';

import { isAddress } from 'viem';

import {
  readBaseSepoliaTokenBalances,
} from '../services/erc20Service.js';

const walletAddress = process.argv[2];

async function main() {
  if (!walletAddress || !isAddress(walletAddress)) {
    throw new Error(
      'Usage: node scripts/check-multi-token-balances.js <PUBLIC_WALLET_ADDRESS>'
    );
  }

  console.log('Reading registered token balances...');
  console.log('------------------------------------');

  const result = await readBaseSepoliaTokenBalances(
    walletAddress
  );

  console.log('\nNETWORK INFORMATION');
  console.log('Network:', result.network);
  console.log('Chain ID:', result.chainId);
  console.log('Wallet:', result.walletAddress);

  console.log('\nREGISTERED TOKEN BALANCES');

  for (const token of result.tokens) {
    console.log('\n----------------------------');
    console.log('Token:', token.symbol);

    if (token.status === 'error') {
      console.log('Status: FAILED');
      console.log('Reason:', token.error);
      continue;
    }

    console.log('Name:', token.name);
    console.log('Issuer:', token.issuer);
    console.log('Decimals:', token.decimals);
    console.log('Contract:', token.contractAddress);
    console.log('Raw balance:', token.rawBalance);
    console.log('Readable balance:', token.balance);
    console.log('Status:', token.status);
  }

  const successful = result.tokens.filter(
    (token) => token.status === 'success'
  ).length;

  console.log('\n------------------------------------');
  console.log(`Successfully read ${successful}/${result.tokens.length} token balances.`);
}

main().catch((error) => {
  console.error('\nToken balance check failed:');
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
});
