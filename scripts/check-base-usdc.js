

import 'dotenv/config';

import {
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  getAddress,
  isAddress,
} from 'viem';

import { baseSepolia } from 'viem/chains';

// Official Circle USDC contract on Base Sepolia.
const TOKEN_ADDRESS = getAddress(
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
);

// The ERC-20 functions we need for this read-only exercise.
const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
]);

// Pass the public wallet address as a command-line argument.
const walletInput = process.argv[2];

if (!walletInput || !isAddress(walletInput)) {
  console.error(
    'Usage: node scripts/check-base-usdc.js <PUBLIC_WALLET_ADDRESS>'
  );
  process.exit(1);
}

const walletAddress = getAddress(walletInput);

// Use the configured Base Sepolia RPC, or its public endpoint.
const rpcUrl =
  process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});

async function main() {
  console.log('Connecting to Base Sepolia...');

  // Confirm that the RPC endpoint is connected to the right chain.
  const chainId = await publicClient.getChainId();

  if (chainId !== baseSepolia.id) {
    throw new Error(
      `Wrong network. Expected ${baseSepolia.id}, received ${chainId}.`
    );
  }

  console.log('Network: Base Sepolia');
  console.log('Chain ID:', chainId);

  // Read token metadata and the selected wallet's raw balance.
  const [name, symbol, decimals, rawBalance] = await Promise.all([
    publicClient.readContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'name',
    }),

    publicClient.readContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'symbol',
    }),

    publicClient.readContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'decimals',
    }),

    publicClient.readContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    }),
  ]);

  // Convert the integer balance into a human-readable token amount.
  const readableBalance = formatUnits(rawBalance, decimals);

  console.log('\n--- TOKEN INFORMATION ---');
  console.log('Token name:', name);
  console.log('Token symbol:', symbol);
  console.log('Decimals:', decimals);
  console.log('Contract address:', TOKEN_ADDRESS);

  console.log('\n--- WALLET BALANCE ---');
  console.log('Wallet:', walletAddress);
  console.log('Raw balance:', rawBalance.toString());
  console.log(`Readable balance: ${readableBalance} ${symbol}`);
}

main().catch((error) => {
  console.error('\nUSDC check failed:');
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
});
