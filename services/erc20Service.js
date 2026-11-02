


import {
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  getAddress,
  isAddress,
} from 'viem';

import { baseSepolia } from 'viem/chains';

import { BASE_SEPOLIA_TOKENS } from '../config/tokenRegistry.js';

// Common ERC-20 functions used by this exercise.
const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
]);

function extractResult(item, description) {
  if (item.status !== 'success') {
    const detail =
      item.error?.shortMessage ||
      item.error?.message ||
      'Unknown RPC error';

    throw new Error(`${description}: ${detail}`);
  }

  return item.result;
}

export async function readBaseSepoliaTokenBalances(walletInput) {
  if (!walletInput || !isAddress(walletInput)) {
    throw new Error('A valid public wallet address is required.');
  }

  const walletAddress = getAddress(walletInput);

  const rpcUrl =
    process.env.BASE_SEPOLIA_RPC_URL ||
    'https://sepolia.base.org';

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  // Verify the connection before reading token contracts.
  const chainId = await publicClient.getChainId();

  if (chainId !== 84532) {
    throw new Error(
      `Wrong network. Expected 84532, received ${chainId}.`
    );
  }

  // Check that every registry entry belongs to this chain.
  const tokens = BASE_SEPOLIA_TOKENS.filter(
    (token) => token.chainId === chainId
  );

  if (tokens.length === 0) {
    throw new Error('No registered tokens found for this network.');
  }

  // Prepare four read operations for each token.
  const contracts = tokens.flatMap((token) => {
    const address = getAddress(token.contractAddress);

    return [
      {
        address,
        abi: ERC20_ABI,
        functionName: 'name',
      },
      {
        address,
        abi: ERC20_ABI,
        functionName: 'symbol',
      },
      {
        address,
        abi: ERC20_ABI,
        functionName: 'decimals',
      },
      {
        address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletAddress],
      },
    ];
  });

  // Batch all the contract reads into one multicall.
  const results = await publicClient.multicall({
    contracts,
    allowFailure: true,
  });

  // Each token has four results in the same order as above.
  const tokenResults = tokens.map((token, index) => {
    const start = index * 4;

    const [
      nameResult,
      symbolResult,
      decimalsResult,
      balanceResult,
    ] = results.slice(start, start + 4);

    try {
      const name = extractResult(nameResult, 'Token name');
      const symbol = extractResult(symbolResult, 'Token symbol');
      const decimals = extractResult(
        decimalsResult,
        'Token decimals'
      );

      const rawBalance = extractResult(
        balanceResult,
        'Wallet balance'
      );

      // Confirm that the contract matches approved registry entry.
      if (
        symbol.toUpperCase() !==
        token.expectedSymbol.toUpperCase()
      ) {
        throw new Error(
          `Symbol mismatch. Expected ${token.expectedSymbol}, received ${symbol}.`
        );
      }

      if (Number(decimals) !== token.decimals) {
        throw new Error(
          `Decimals mismatch for ${token.expectedSymbol}.`
        );
      }

      return {
        id: token.id,
        name,
        symbol,
        issuer: token.issuer,
        network: token.network,
        chainId,
        contractAddress: getAddress(token.contractAddress),
        decimals: Number(decimals),
        rawBalance: rawBalance.toString(),
        balance: formatUnits(rawBalance, Number(decimals)),
        status: 'success',
      };

    } catch (error) {
      return {
        id: token.id,
        symbol: token.expectedSymbol,
        contractAddress: token.contractAddress,
        status: 'error',
        error: error.message,
      };
    }
  });

  return {
    walletAddress,
    network: baseSepolia.name,
    chainId,
    tokens: tokenResults,
  };
}
