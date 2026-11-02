


import 'dotenv/config';

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  formatUnits,
  getAddress,
  isAddress,
} from 'viem';

import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import { BASE_SEPOLIA_TOKENS } from '../config/tokenRegistry.js';

const EXPECTED_SENDER =
  getAddress('0x99DeA1c204ea2e0E71d17C7C87AA97750556b618');

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
]);

async function main() {
  const recipientInput = process.argv[2];
  const amountInput = process.argv[3] ?? '1';

  if (!process.env.BASE_SEPOLIA_PRIVATE_KEY) {
    throw new Error(
      'BASE_SEPOLIA_PRIVATE_KEY is missing from your local .env file.'
    );
  }

  if (!recipientInput || !isAddress(recipientInput)) {
    throw new Error(
      'Usage: node scripts/send-test-usdc.js <RECIPIENT_ADDRESS> [AMOUNT]'
    );
  }

  if (!/^\d+(\.\d+)?$/.test(amountInput)) {
    throw new Error('Enter a valid positive token amount.');
  }

  const recipient = getAddress(recipientInput);

  // Identify USDC from our approved testnet token registry.
  const token = BASE_SEPOLIA_TOKENS.find(
    (item) =>
      item.expectedSymbol === 'USDC' &&
      item.chainId === baseSepolia.id
  );

  if (!token) {
    throw new Error('USDC is not registered on Base Sepolia.');
  }

  const tokenAddress = getAddress(token.contractAddress);

  // The dedicated local test wallet signs this transaction.
  const account = privateKeyToAccount(
    process.env.BASE_SEPOLIA_PRIVATE_KEY
  );

  
  if (
    account.address.toLowerCase() !==
    EXPECTED_SENDER.toLowerCase()
  ) {
    throw new Error(
      `Signer mismatch. Expected ${EXPECTED_SENDER}, received ${account.address}. No transaction was sent.`
    );
  }

  if (account.address.toLowerCase() === recipient.toLowerCase()) {
    throw new Error(
      'Choose another wallet address so that the transfer can be demonstrated.'
    );
  }

  const rpcUrl =
    process.env.BASE_SEPOLIA_RPC_URL ||
    'https://sepolia.base.org';

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  console.log('Checking Base Sepolia connection...');

  const chainId = await publicClient.getChainId();

  if (chainId !== 84532) {
    throw new Error(
      `Wrong network. Expected 84532, received ${chainId}.`
    );
  }

  // Verify the token contract metadata before using it.
  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'symbol',
    }),
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'decimals',
    }),
  ]);

  if (symbol !== 'USDC' || Number(decimals) !== token.decimals) {
    throw new Error('The USDC contract metadata did not match our registry.');
  }

  const amount = parseUnits(amountInput, Number(decimals));

  if (amount <= 0n) {
    throw new Error('Transfer amount must be greater than zero.');
  }

  const [senderBalance, recipientBalance, ethBalance] =
    await Promise.all([
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [recipient],
      }),
      publicClient.getBalance({
        address: account.address,
      }),
    ]);

  console.log('\n--- TRANSFER REVIEW ---');
  console.log('Network: Base Sepolia');
  console.log('Chain ID:', chainId);
  console.log('Token:', symbol);
  console.log('Sender:', account.address);
  console.log('Recipient:', recipient);
  console.log('Amount:', `${amountInput} ${symbol}`);
  console.log(
    'Sender balance:',
    `${formatUnits(senderBalance, Number(decimals))} ${symbol}`
  );
  console.log(
    'Recipient balance before:',
    `${formatUnits(recipientBalance, Number(decimals))} ${symbol}`
  );
  console.log('Sender ETH balance:', formatUnits(ethBalance, 18));

  if (senderBalance < amount) {
    throw new Error('Insufficient USDC balance.');
  }

  if (ethBalance === 0n) {
    throw new Error('The sender wallet has no Base Sepolia ETH for gas.');
  }

  // Simulate the transfer first.
  const { request, result } = await publicClient.simulateContract({
    account,
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [recipient, amount],
  });

  if (result !== true) {
    throw new Error('The token contract did not approve the transfer simulation.');
  }

  console.log('\nSimulation successful. Submitting transaction...');

  // Sign and submit the actual testnet transaction.
  const hash = await walletClient.writeContract(request);

  console.log('Transaction hash:', hash);
  console.log(
    'Explorer:',
    `https://sepolia.basescan.org/tx/${hash}`
  );

  console.log('\nWaiting for blockchain confirmation...');

  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
  });

  if (receipt.status !== 'success') {
    throw new Error('The transaction was included but reverted.');
  }

  // Read balances again after confirmation.
  const [newSenderBalance, newRecipientBalance] =
    await Promise.all([
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
      }),
      publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [recipient],
      }),
    ]);

  console.log('\n--- TRANSFER CONFIRMED ---');
  console.log('Status:', receipt.status);
  console.log('Block number:', receipt.blockNumber.toString());
  console.log('Gas used:', receipt.gasUsed.toString());
  console.log(
    'Sender balance after:',
    `${formatUnits(newSenderBalance, Number(decimals))} ${symbol}`
  );
  console.log(
    'Recipient balance after:',
    `${formatUnits(newRecipientBalance, Number(decimals))} ${symbol}`
  );
  console.log('Transaction hash:', hash);
}

main().catch((error) => {
  console.error('\nTransfer failed:');
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
});
