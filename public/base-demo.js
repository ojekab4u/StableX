// import {
//   createPublicClient,
//   createWalletClient,
//   custom,
//   http,
//   parseAbi,
//   parseUnits,
//   formatUnits,
//   getAddress,
//   isAddress,
// } from 'https://esm.sh/viem@2.57.12';
// import { baseSepolia } from 'https://esm.sh/viem@2.57.12/chains';

// const BASE_SEPOLIA_USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
// const BASE_SEPOLIA_EURC = getAddress('0x808456652fdb597867f38412077A9182bf77359F');
// const RPC_URL = 'https://sepolia.base.org';
// const EXPECTED_CHAIN_ID = 84532;
// const ERC20_ABI = parseAbi([
//   'function name() view returns (string)',
//   'function symbol() view returns (string)',
//   'function decimals() view returns (uint8)',
//   'function balanceOf(address account) view returns (uint256)',
//   'function transfer(address to, uint256 value) returns (bool)',
// ]);

// const $ = (id) => document.getElementById(id);
// const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
// const discovered = new Map();
// let selectedProvider = null;
// let activeAccount = null;
// let walletClient = null;
// let tokenDecimals = 6;
// let usdcBalance = 0n;

// function setMessage(id, message, kind = '') {
//   const el = $(id);
//   el.textContent = message;
//   el.className = `inline-message${kind ? ` ${kind}` : ''}`;
// }

// function shortAddress(address) {
//   return `${address.slice(0, 8)}…${address.slice(-6)}`;
// }

// function renderWalletOptions() {
//   const select = $('wallet-select');
//   const previous = select.value;
//   select.replaceChildren();
//   if (discovered.size === 0) {
//     const option = document.createElement('option');
//     option.value = '';
//     option.textContent = 'No wallet detected';
//     select.append(option);
//     return;
//   }
//   for (const [id, item] of discovered) {
//     const option = document.createElement('option');
//     option.value = id;
//     option.textContent = item.info?.name || 'Browser wallet';
//     select.append(option);
//   }
//   if (discovered.has(previous)) select.value = previous;
// }

// function addDiscoveredWallet(detail) {
//   if (!detail?.provider) return;
//   const info = detail.info || {};
//   const id = info.uuid || `wallet-${discovered.size + 1}`;
//   discovered.set(id, { info, provider: detail.provider });
//   renderWalletOptions();
// }

// window.addEventListener('eip6963:announceProvider', (event) => addDiscoveredWallet(event.detail));
// window.dispatchEvent(new Event('eip6963:requestProvider'));

// async function detectWallets() {
//   await new Promise((resolve) => setTimeout(resolve, 800));
//   // Compatibility fallback for wallets that do not announce through EIP-6963.
//   if (discovered.size === 0 && window.ethereum) {
//     const providers = Array.isArray(window.ethereum.providers)
//       ? window.ethereum.providers
//       : [window.ethereum];
//     providers.forEach((provider, index) => {
//       addDiscoveredWallet({
//         info: { uuid: `legacy-${index}`, name: providers.length > 1 ? `Injected wallet ${index + 1}` : 'Injected wallet' },
//         provider,
//       });
//     });
//   }
//   renderWalletOptions();
// }

// async function ensureBaseSepolia(provider) {
//   let chainId = Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16);
//   if (chainId === EXPECTED_CHAIN_ID) return;
//   try {
//     await provider.request({
//       method: 'wallet_switchEthereumChain',
//       params: [{ chainId: '0x14a34' }],
//     });
//   } catch (error) {
//     if (error.code !== 4902) throw error;
//     await provider.request({
//       method: 'wallet_addEthereumChain',
//       params: [{
//         chainId: '0x14a34',
//         chainName: 'Base Sepolia',
//         nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
//         rpcUrls: [RPC_URL],
//         blockExplorerUrls: ['https://sepolia.basescan.org'],
//       }],
//     });
//   }
//   chainId = Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16);
//   if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`Wallet is on chain ${chainId}, not Base Sepolia.`);
// }

// async function readBalances() {
//   if (!activeAccount) return;
//   $('wallet-message').textContent = 'Reading token balances from Base Sepolia…';
//   const [eth, usdc, eurc] = await Promise.all([
//     publicClient.getBalance({ address: activeAccount }),
//     publicClient.readContract({ address: BASE_SEPOLIA_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [activeAccount] }),
//     publicClient.readContract({ address: BASE_SEPOLIA_EURC, abi: ERC20_ABI, functionName: 'balanceOf', args: [activeAccount] }),
//   ]);
//   const [usdcSymbol, usdcDecimals, eurcSymbol, eurcDecimals] = await Promise.all([
//     publicClient.readContract({ address: BASE_SEPOLIA_USDC, abi: ERC20_ABI, functionName: 'symbol' }),
//     publicClient.readContract({ address: BASE_SEPOLIA_USDC, abi: ERC20_ABI, functionName: 'decimals' }),
//     publicClient.readContract({ address: BASE_SEPOLIA_EURC, abi: ERC20_ABI, functionName: 'symbol' }),
//     publicClient.readContract({ address: BASE_SEPOLIA_EURC, abi: ERC20_ABI, functionName: 'decimals' }),
//   ]);
//   if (usdcSymbol !== 'USDC' || eurcSymbol !== 'EURC' || Number(usdcDecimals) !== 6 || Number(eurcDecimals) !== 6) {
//     throw new Error('Token contract metadata did not match the expected testnet assets.');
//   }
//   tokenDecimals = Number(usdcDecimals);
//   usdcBalance = usdc;
//   $('eth-value').textContent = `${Number(formatUnits(eth, 18)).toFixed(6)} ETH`;
//   $('available-usdc').textContent = `${formatUnits(usdc, tokenDecimals)} USDC`;
//   $('token-balances').innerHTML = `
//     <div class="balance-card"><span class="token-symbol">USDC</span><strong>${formatUnits(usdc, Number(usdcDecimals))}</strong><small>USD Coin · Base Sepolia</small></div>
//     <div class="balance-card"><span class="token-symbol">EURC</span><strong>${formatUnits(eurc, Number(eurcDecimals))}</strong><small>Euro Coin · Base Sepolia</small></div>`;
//   $('refresh-balances').disabled = false;
//   $('send-transfer').disabled = false;
//   $('send-transfer').textContent = 'Review and send test USDC';
//   setMessage('wallet-message', 'Wallet connected. Balances were read directly from the token contracts.', 'success');
// }

// async function connectWallet() {
//   const choice = discovered.get($('wallet-select').value);
//   if (!choice) throw new Error('Select a detected wallet first.');
//   selectedProvider = choice.provider;
//   await ensureBaseSepolia(selectedProvider);
//   const accounts = await selectedProvider.request({ method: 'eth_requestAccounts' });
//   if (!accounts?.length) throw new Error('The wallet did not provide an account.');
//   activeAccount = getAddress(accounts[0]);
//   walletClient = createWalletClient({ account: activeAccount, chain: baseSepolia, transport: custom(selectedProvider) });
//   $('account-value').textContent = `${shortAddress(activeAccount)} · ${activeAccount}`;
//   $('chain-value').textContent = 'Base Sepolia · 84532';
//   await readBalances();
// }

// function renderQuotes(data) {
//   const container = $('quote-results');
//   container.replaceChildren();
//   if (!data.quotes?.length) {
//     container.className = 'quote-results empty-state';
//     container.textContent = 'No provider returned an available quote.';
//     return;
//   }
//   container.className = 'quote-results';
//   data.quotes.forEach((quote, index) => {
//     const card = document.createElement('article');
//     card.className = `provider-card${index === 0 ? ' best' : ''}`;
//     const head = document.createElement('div');
//     head.className = 'provider-head';
//     const name = document.createElement('span');
//     name.className = 'provider-name';
//     name.textContent = quote.provider;
//     head.append(name);
//     if (index === 0) {
//       const rank = document.createElement('span');
//       rank.className = 'provider-rank';
//       rank.textContent = 'BEST NET OUTPUT';
//       head.append(rank);
//     }
//     const output = document.createElement('div');
//     output.className = 'provider-output';
//     output.textContent = `${Number(quote.netAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${quote.to}`;
//     const sub = document.createElement('div');
//     sub.className = 'provider-sub';
//     sub.textContent = 'Estimated net output · simulated';
//     const details = document.createElement('div');
//     details.className = 'provider-details';
//     const fields = [
//       ['RATE', Number(quote.rate).toLocaleString(undefined, { maximumFractionDigits: 8 })],
//       ['FEE', `${Number(quote.fee).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${quote.feeCurrency || quote.to}`],
//       ['LIQUIDITY MODEL', quote.liquidityCheck?.model || 'DEMO'],
//       ['PROCESSING', quote.processingTime || 'Not specified'],
//     ];
//     fields.forEach(([label, value]) => {
//       const cell = document.createElement('div');
//       const small = document.createElement('span'); small.textContent = label;
//       const strong = document.createElement('strong'); strong.textContent = value;
//       cell.append(small, strong); details.append(cell);
//     });
//     card.append(head, output, sub, details);
//     container.append(card);
//   });
// }

// async function compareQuotes(event) {
//   event.preventDefault();
//   const amount = $('quote-amount').value;
//   const from = $('quote-from').value;
//   const to = $('quote-to').value;
//   if (from === to) { $('quote-message').textContent = 'Choose two different assets.'; return; }
//   $('quote-message').textContent = 'Requesting simulated provider quotes…';
//   $('quote-results').className = 'quote-results empty-state';
//   $('quote-results').textContent = 'Checking providers…';
//   try {
//     const params = new URLSearchParams({ amount, from, to });
//     const response = await fetch(`/api/quotes?${params.toString()}`);
//     const data = await response.json();
//     if (!response.ok) throw new Error(data.error || 'Quote request failed.');
//     renderQuotes(data);
//     $('quote-message').textContent = `${data.quotes.length} simulated provider quote(s) returned. ${data.disclaimer || ''}`;
//   } catch (error) {
//     $('quote-results').className = 'quote-results empty-state';
//     $('quote-results').textContent = error.message;
//     $('quote-message').textContent = 'Quote request could not be completed.';
//   }
// }

// async function sendUsdc(event) {
//   event.preventDefault();
//   if (!walletClient || !activeAccount || !selectedProvider) throw new Error('Connect a wallet first.');
//   await ensureBaseSepolia(selectedProvider);
//   const recipientInput = $('recipient-address').value.trim();
//   const amountInput = $('transfer-amount').value.trim();
//   if (!isAddress(recipientInput)) throw new Error('Enter a valid recipient wallet address.');
//   if (!/^\d+(\.\d{1,6})?$/.test(amountInput) || Number(amountInput) <= 0) {
//     throw new Error('Enter a positive USDC amount with no more than 6 decimal places.');
//   }
//   const recipient = getAddress(recipientInput);
//   if (recipient.toLowerCase() === activeAccount.toLowerCase()) throw new Error('Recipient must be different from the connected sender.');
//   const amount = parseUnits(amountInput, tokenDecimals);
//   const [freshBalance, ethBalance] = await Promise.all([
//     publicClient.readContract({ address: BASE_SEPOLIA_USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [activeAccount] }),
//     publicClient.getBalance({ address: activeAccount }),
//   ]);
//   if (freshBalance < amount) throw new Error('Insufficient USDC balance. Refresh balances or request test USDC.');
//   if (ethBalance === 0n) throw new Error('No Base Sepolia ETH is available to pay gas.');
//   const readableAmount = formatUnits(amount, tokenDecimals);
//   const approved = window.confirm(`Send ${readableAmount} test USDC?\n\nFrom: ${activeAccount}\nTo: ${recipient}\nNetwork: Base Sepolia\n\nYour wallet will ask you to sign. This is a testnet transaction with no monetary value.`);
//   if (!approved) return;

//   $('send-transfer').disabled = true;
//   $('send-transfer').textContent = 'Preparing transaction…';
//   const resultPanel = $('live-transaction');
//   resultPanel.classList.remove('hidden');
//   resultPanel.textContent = 'Simulating token transfer…';
//   try {
//     const simulation = await publicClient.simulateContract({
//       account: activeAccount,
//       address: BASE_SEPOLIA_USDC,
//       abi: ERC20_ABI,
//       functionName: 'transfer',
//       args: [recipient, amount],
//     });
//     if (simulation.result !== true) throw new Error('USDC contract simulation did not return true.');
//     $('send-transfer').textContent = 'Confirm in your wallet…';
//     resultPanel.textContent = 'Simulation passed. Confirm the transaction in your selected wallet.';
//     const hash = await walletClient.writeContract(simulation.request);
//     resultPanel.innerHTML = '';
//     const pending = document.createElement('p'); pending.textContent = 'Transaction submitted. Waiting for Base Sepolia confirmation…';
//     const hashText = document.createElement('code'); hashText.textContent = hash;
//     const link = document.createElement('a'); link.href = `https://sepolia.basescan.org/tx/${hash}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open transaction on BaseScan ↗';
//     resultPanel.append(pending, hashText, document.createElement('br'), link);
//     const receipt = await publicClient.waitForTransactionReceipt({ hash });
//     const status = document.createElement('p');
//     status.textContent = receipt.status === 'success' ? `Confirmed successfully in block ${receipt.blockNumber}. Gas used: ${receipt.gasUsed}.` : 'Transaction receipt returned a reverted status.';
//     resultPanel.append(status);
//     if (receipt.status !== 'success') throw new Error('The transaction was included but reverted.');
//     await readBalances();
//     setMessage('transfer-message', 'Transfer confirmed on Base Sepolia. The transaction link is available above.', 'success');
//   } catch (error) {
//     resultPanel.classList.remove('hidden');
//     const errorText = document.createElement('p');
//     errorText.textContent = error.shortMessage || error.message || 'Transfer failed.';
//     resultPanel.append(errorText);
//     throw error;
//   } finally {
//     $('send-transfer').disabled = !activeAccount;
//     $('send-transfer').textContent = 'Review and send test USDC';
//   }
// }

// $('connect-wallet').addEventListener('click', async () => {
//   try { await connectWallet(); }
//   catch (error) { setMessage('wallet-message', error.shortMessage || error.message, 'error'); }
// });
// $('refresh-wallets').addEventListener('click', detectWallets);
// $('refresh-balances').addEventListener('click', async () => {
//   try { await readBalances(); }
//   catch (error) { setMessage('wallet-message', error.shortMessage || error.message, 'error'); }
// });
// $('quote-form').addEventListener('submit', compareQuotes);
// $('transfer-form').addEventListener('submit', async (event) => {
//   try { await sendUsdc(event); }
//   catch (error) { setMessage('transfer-message', error.shortMessage || error.message || 'Transfer failed.', 'error'); }
// });
// $('copy-hash').addEventListener('click', async () => {
//   const hash = $('previous-hash').textContent.trim();
//   try { await navigator.clipboard.writeText(hash); $('copy-hash').textContent = 'Copied'; }
//   catch { $('copy-hash').textContent = 'Copy unavailable'; }
// });

// (async function initialise() {
//   try {
//     const chainId = await publicClient.getChainId();
//     if (chainId === EXPECTED_CHAIN_ID) {
//       $('rpc-status').textContent = 'Base RPC connected';
//       $('rpc-detail').textContent = 'Base Sepolia · Chain ID 84532';
//     } else {
//       $('rpc-status').textContent = 'Unexpected chain';
//       $('rpc-detail').textContent = `Received Chain ID ${chainId}`;
//     }
//   } catch (error) {
//     $('rpc-status').textContent = 'RPC connection unavailable';
//     $('rpc-detail').textContent = error.shortMessage || error.message;
//   }
//   await detectWallets();
//   compareQuotes(new Event('submit', { cancelable: true }));
// })();

// // Keep the UI honest if the user changes accounts or networks in the wallet.
// window.addEventListener('focus', async () => {
//   if (!selectedProvider || !activeAccount) return;
//   try {
//     const accounts = await selectedProvider.request({ method: 'eth_accounts' });
//     const chainId = Number.parseInt(await selectedProvider.request({ method: 'eth_chainId' }), 16);
//     if (!accounts?.length || chainId !== EXPECTED_CHAIN_ID || accounts[0].toLowerCase() !== activeAccount.toLowerCase()) {
//       activeAccount = null;
//       walletClient = null;
//       $('account-value').textContent = 'Not connected';
//       $('chain-value').textContent = 'Not connected';
//       $('eth-value').textContent = '—';
//       $('available-usdc').textContent = '— USDC';
//       $('refresh-balances').disabled = true;
//       $('send-transfer').disabled = true;
//       $('send-transfer').textContent = 'Reconnect wallet';
//       setMessage('wallet-message', 'Wallet account or network changed. Connect again to refresh the session.');
//     }
//   } catch { /* The next explicit wallet connection will report any provider error. */ }
// });




import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  parseUnits,
  formatUnits,
  getAddress,
  isAddress,
} from 'https://esm.sh/viem@2.57.12';

import { baseSepolia } from 'https://esm.sh/viem@2.57.12/chains';

const BASE_SEPOLIA_USDC = getAddress(
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
);

const BASE_SEPOLIA_EURC = getAddress(
  '0x808456652fdb597867f38412077A9182bf77359F'
);

const RPC_URL = 'https://sepolia.base.org';
const EXPECTED_CHAIN_ID = 84532;

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
]);

const $ = (id) => document.getElementById(id);

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});

const discovered = new Map();
const providerListeners = new WeakSet();

let selectedProvider = null;
let activeAccount = null;
let walletClient = null;
let tokenDecimals = 6;
let usdcBalance = 0n;
let discoveryInProgress = false;

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function setMessage(id, message, kind = '') {
  const element = $(id);

  element.textContent = message;
  element.className = `inline-message${kind ? ` ${kind}` : ''}`;
}

function shortAddress(address) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function providerLabel(provider) {
  if (provider?.isMetaMask) return 'MetaMask';
  if (provider?.isKeplr) return 'Keplr';
  if (provider?.isRabby) return 'Rabby';
  if (provider?.isCoinbaseWallet) return 'Coinbase Wallet';

  return 'Injected wallet';
}

// --------------------------------------------------
// WALLET DISCOVERY
// --------------------------------------------------

function renderWalletOptions() {
  const select = $('wallet-select');
  const previous = select.value;

  select.replaceChildren();

  const placeholder = document.createElement('option');

  placeholder.value = '';

  placeholder.textContent = discovered.size
    ? 'Choose a wallet explicitly…'
    : 'Click Discover wallets to begin';

  select.append(placeholder);

  for (const [id, item] of discovered) {
    const option = document.createElement('option');

    option.value = id;

    const name = item.info?.name || 'Browser wallet';
    const rdns = item.info?.rdns
      ? ` · ${item.info.rdns}`
      : '';

    option.textContent = `${name}${rdns}`;

    select.append(option);
  }

  // Never automatically select a wallet.
  select.value = discovered.has(previous)
    ? previous
    : '';

  $('connect-wallet').disabled = !select.value;

  $('connect-wallet').textContent = select.value
    ? 'Connect selected wallet'
    : 'Select a wallet first';
}

function addDiscoveredWallet(detail) {
  const provider = detail?.provider;

  if (
    !provider ||
    typeof provider.request !== 'function'
  ) {
    return;
  }

  const info = detail.info || {};

  const existing = [...discovered.values()].find(
    (item) => item.provider === provider
  );

  if (existing) return;

  const id = info.uuid ||
    `legacy-${discovered.size + 1}`;

  if (discovered.has(id)) return;

  discovered.set(id, {
    info: {
      name: info.name || providerLabel(provider),
      rdns: info.rdns || '',
      uuid: info.uuid || id,
    },
    provider,
  });

  renderWalletOptions();
}

// EIP-6963 announcement listener.
// This listener does not itself request wallet access.
window.addEventListener(
  'eip6963:announceProvider',
  (event) => {
    addDiscoveredWallet(event.detail);
  }
);

// Legacy wallet detection.
// This only collects providers; it does not connect them.
function addLegacyInjectedProviders() {
  const injected = window.ethereum;

  if (!injected) return;

  const providers = Array.isArray(injected.providers)
    ? injected.providers
    : [injected];

  providers.forEach((provider) => {
    addDiscoveredWallet({
      info: {
        name: providerLabel(provider),
        rdns: 'legacy-injected-provider',
      },
      provider,
    });
  });
}

async function detectWallets() {
  if (discoveryInProgress) return;

  discoveryInProgress = true;

  $('refresh-wallets').disabled = true;
  $('refresh-wallets').textContent = 'Discovering…';

  setMessage(
    'wallet-message',
    'Discovering available wallets. No account access or transaction is being requested.'
  );

  try {
    // This request occurs only after the user clicks Discover wallets.
    window.dispatchEvent(
      new Event('eip6963:requestProvider')
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 800)
    );

    addLegacyInjectedProviders();

    renderWalletOptions();

    if (discovered.size === 0) {
      setMessage(
        'wallet-message',
        'No EVM wallet was detected. Check your wallet extensions.',
        'error'
      );
    } else {
      setMessage(
        'wallet-message',
        `${discovered.size} wallet provider(s) detected. Select your preferred wallet before connecting.`,
        'success'
      );
    }
  } finally {
    discoveryInProgress = false;

    $('refresh-wallets').disabled = false;
    $('refresh-wallets').textContent = 'Discover wallets';
  }
}

// --------------------------------------------------
// WALLET SESSION
// --------------------------------------------------

function clearWalletSession(
  message = 'Wallet disconnected from this page.'
) {
  activeAccount = null;
  selectedProvider = null;
  walletClient = null;

  $('account-value').textContent = 'Not connected';
  $('chain-value').textContent = 'Not connected';
  $('eth-value').textContent = '—';
  $('available-usdc').textContent = '— USDC';

  $('refresh-balances').disabled = true;
  $('send-transfer').disabled = true;

  $('send-transfer').textContent =
    'Connect wallet to continue';

  $('token-balances').innerHTML = `
    <div class="balance-card">
      <span class="token-symbol">USDC</span>
      <strong>—</strong>
      <small>Connect a wallet to read balance</small>
    </div>

    <div class="balance-card">
      <span class="token-symbol">EURC</span>
      <strong>—</strong>
      <small>Connect a wallet to read balance</small>
    </div>
  `;

  setMessage('wallet-message', message);
}

async function ensureBaseSepolia(provider) {
  let chainId = Number.parseInt(
    await provider.request({
      method: 'eth_chainId',
    }),
    16
  );

  if (chainId === EXPECTED_CHAIN_ID) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x14a34' }],
    });
  } catch (error) {
    if (error.code !== 4902) {
      throw error;
    }

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: '0x14a34',
        chainName: 'Base Sepolia',
        nativeCurrency: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
        },
        rpcUrls: [RPC_URL],
        blockExplorerUrls: [
          'https://sepolia.basescan.org',
        ],
      }],
    });
  }

  chainId = Number.parseInt(
    await provider.request({
      method: 'eth_chainId',
    }),
    16
  );

  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Wrong network. Expected Base Sepolia (84532), received ${chainId}.`
    );
  }
}

// --------------------------------------------------
// TOKEN BALANCES
// --------------------------------------------------

async function readBalances() {
  if (!activeAccount) return;

  $('wallet-message').textContent =
    'Reading Base Sepolia balances…';

  const [
    eth,
    usdc,
    eurc,
  ] = await Promise.all([
    publicClient.getBalance({
      address: activeAccount,
    }),

    publicClient.readContract({
      address: BASE_SEPOLIA_USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [activeAccount],
    }),

    publicClient.readContract({
      address: BASE_SEPOLIA_EURC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [activeAccount],
    }),
  ]);

  const [
    usdcSymbol,
    usdcDecimals,
    eurcSymbol,
    eurcDecimals,
  ] = await Promise.all([
    publicClient.readContract({
      address: BASE_SEPOLIA_USDC,
      abi: ERC20_ABI,
      functionName: 'symbol',
    }),

    publicClient.readContract({
      address: BASE_SEPOLIA_USDC,
      abi: ERC20_ABI,
      functionName: 'decimals',
    }),

    publicClient.readContract({
      address: BASE_SEPOLIA_EURC,
      abi: ERC20_ABI,
      functionName: 'symbol',
    }),

    publicClient.readContract({
      address: BASE_SEPOLIA_EURC,
      abi: ERC20_ABI,
      functionName: 'decimals',
    }),
  ]);

  if (
    usdcSymbol !== 'USDC' ||
    eurcSymbol !== 'EURC' ||
    Number(usdcDecimals) !== 6 ||
    Number(eurcDecimals) !== 6
  ) {
    throw new Error(
      'Token metadata did not match the expected testnet assets.'
    );
  }

  tokenDecimals = Number(usdcDecimals);
  usdcBalance = usdc;

  $('eth-value').textContent =
    `${Number(formatUnits(eth, 18)).toFixed(6)} ETH`;

  $('available-usdc').textContent =
    `${formatUnits(usdc, tokenDecimals)} USDC`;

  $('token-balances').innerHTML = `
    <div class="balance-card">
      <span class="token-symbol">USDC</span>
      <strong>${formatUnits(usdc, Number(usdcDecimals))}</strong>
      <small>USD Coin · Base Sepolia</small>
    </div>

    <div class="balance-card">
      <span class="token-symbol">EURC</span>
      <strong>${formatUnits(eurc, Number(eurcDecimals))}</strong>
      <small>Euro Coin · Base Sepolia</small>
    </div>
  `;

  $('refresh-balances').disabled = false;
  $('send-transfer').disabled = false;

  $('send-transfer').textContent =
    'Review and send test USDC';

  setMessage(
    'wallet-message',
    'Wallet connected. Token balances were read directly from Base.',
    'success'
  );
}

// --------------------------------------------------
// WALLET CHANGE LISTENERS
// --------------------------------------------------

function attachProviderListeners(provider) {
  if (
    providerListeners.has(provider) ||
    typeof provider.on !== 'function'
  ) {
    return;
  }

  providerListeners.add(provider);

  provider.on('accountsChanged', async (accounts) => {
    if (selectedProvider !== provider) return;

    if (!accounts?.length) {
      clearWalletSession(
        'The selected wallet disconnected this site.'
      );
      return;
    }

    activeAccount = getAddress(accounts[0]);

    walletClient = createWalletClient({
      account: activeAccount,
      chain: baseSepolia,
      transport: custom(provider),
    });

    $('account-value').textContent = activeAccount;
      $('account-value').title = activeAccount;

    try {
      await readBalances();
    } catch (error) {
      setMessage(
        'wallet-message',
        error.shortMessage || error.message,
        'error'
      );
    }
  });

  provider.on('chainChanged', async (chainHex) => {
    if (selectedProvider !== provider) return;

    const chainId = Number.parseInt(chainHex, 16);

    if (chainId !== EXPECTED_CHAIN_ID) {
      $('chain-value').textContent =
        `Wrong network · ${chainId}`;

      $('send-transfer').disabled = true;

      setMessage(
        'wallet-message',
        'Switch back to Base Sepolia to continue.',
        'error'
      );

      return;
    }

    $('chain-value').textContent =
      'Base Sepolia · 84532';

    if (activeAccount) {
      try {
        await readBalances();
      } catch (error) {
        setMessage(
          'wallet-message',
          error.shortMessage || error.message,
          'error'
        );
      }
    }
  });

  provider.on('disconnect', () => {
    if (selectedProvider === provider) {
      clearWalletSession(
        'The selected wallet provider disconnected.'
      );
    }
  });
}

// --------------------------------------------------
// CONNECT SELECTED WALLET
// --------------------------------------------------


async function connectWallet() {
  const choice = discovered.get(
    $('wallet-select').value
  );

  if (!choice) {
    setMessage(
      'wallet-message',
      'Please select a wallet first.',
      'error'
    );
    return;
  }

  const provider = choice.provider;

  $('connect-wallet').disabled = true;
  $('connect-wallet').textContent = 'Waiting for approval…';

  setMessage(
    'wallet-message',
    `Please approve the connection request in ${choice.info.name}.`
  );

  try {
    // Request account access only after the Connect button is clicked.
    // Do not call eth_accounts first.
    const accounts = await provider.request({
      method: 'eth_requestAccounts',
    });

    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error(
        'No account was authorised by the selected wallet.'
      );
    }

    const account = getAddress(accounts[0]);

    // Request Base Sepolia after account access is granted.
    await ensureBaseSepolia(provider);

    const chainId = Number.parseInt(
      await provider.request({
        method: 'eth_chainId',
      }),
      16
    );

    if (chainId !== EXPECTED_CHAIN_ID) {
      throw new Error('Please connect to Base Sepolia.');
    }

    // Only now establish the application wallet session.
    selectedProvider = provider;
    activeAccount = account;

    walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: custom(provider),
    });

    attachProviderListeners(provider);

    // Show the complete authorised wallet address.
    $('account-value').textContent = account;
    $('account-value').title = account;

    $('chain-value').textContent =
      'Base Sepolia · 84532';

    await readBalances();

    setMessage(
      'wallet-message',
      `${choice.info.name} connected successfully.`,
      'success'
    );

  } catch (error) {
    selectedProvider = null;
    activeAccount = null;
    walletClient = null;

    $('account-value').textContent = 'Not connected';
    $('chain-value').textContent = 'Not connected';

    $('send-transfer').disabled = true;

    if (error.code === 4001) {
      setMessage(
        'wallet-message',
        'You rejected the wallet connection. No account was connected.',
        'error'
      );
    } else {
      setMessage(
        'wallet-message',
        error.shortMessage || error.message,
        'error'
      );
    }

  } finally {
    $('connect-wallet').disabled =
      !$('wallet-select').value;

    $('connect-wallet').textContent =
      'Connect selected wallet';
  }
}

// --------------------------------------------------
// QUOTE COMPARISON
// --------------------------------------------------

function renderQuotes(data) {
  const container = $('quote-results');

  container.replaceChildren();

  if (!data.quotes?.length) {
    container.className =
      'quote-results empty-state';

    container.textContent =
      'No provider returned an available quote.';

    return;
  }

  container.className = 'quote-results';

  data.quotes.forEach((quote, index) => {
    const card = document.createElement('article');

    card.className =
      `provider-card${index === 0 ? ' best' : ''}`;

    const head = document.createElement('div');
    head.className = 'provider-head';

    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = quote.provider;

    head.append(name);

    if (index === 0) {
      const rank = document.createElement('span');

      rank.className = 'provider-rank';
      rank.textContent = 'BEST NET OUTPUT';

      head.append(rank);
    }

    const output = document.createElement('div');

    output.className = 'provider-output';

    output.textContent =
      `${Number(quote.netAmount).toLocaleString(undefined, {
        maximumFractionDigits: 6,
      })} ${quote.to}`;

    const sub = document.createElement('div');

    sub.className = 'provider-sub';
    sub.textContent = 'Estimated net output · simulated';

    const details = document.createElement('div');

    details.className = 'provider-details';

    const fields = [
      [
        'RATE',
        Number(quote.rate).toLocaleString(undefined, {
          maximumFractionDigits: 8,
        }),
      ],
      [
        'FEE',
        `${Number(quote.fee).toLocaleString(undefined, {
          maximumFractionDigits: 6,
        })} ${quote.feeCurrency || quote.to}`,
      ],
      [
        'LIQUIDITY MODEL',
        quote.liquidityCheck?.model || 'DEMO',
      ],
      [
        'PROCESSING',
        quote.processingTime || 'Not specified',
      ],
    ];

    fields.forEach(([label, value]) => {
      const cell = document.createElement('div');

      const small = document.createElement('span');
      small.textContent = label;

      const strong = document.createElement('strong');
      strong.textContent = value;

      cell.append(small, strong);
      details.append(cell);
    });

    card.append(head, output, sub, details);
    container.append(card);
  });
}

async function compareQuotes(event) {
  event.preventDefault();

  const amount = $('quote-amount').value;
  const from = $('quote-from').value;
  const to = $('quote-to').value;

  if (from === to) {
    $('quote-message').textContent =
      'Choose two different assets.';
    return;
  }

  $('quote-message').textContent =
    'Requesting simulated provider quotes…';

  $('quote-results').className =
    'quote-results empty-state';

  $('quote-results').textContent =
    'Checking providers…';

  try {
    const params = new URLSearchParams({
      amount,
      from,
      to,
    });

    const response = await fetch(
      `/api/quotes?${params.toString()}`
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || 'Quote request failed.'
      );
    }

    renderQuotes(data);

    $('quote-message').textContent =
      `${data.quotes.length} simulated provider quote(s) returned. ${data.disclaimer || ''}`;

  } catch (error) {
    $('quote-results').className =
      'quote-results empty-state';

    $('quote-results').textContent = error.message;

    $('quote-message').textContent =
      'Quote request could not be completed.';
  }
}

// --------------------------------------------------
// USDC TRANSFER
// --------------------------------------------------

async function sendUsdc(event) {
  event.preventDefault();

  if (!walletClient || !activeAccount || !selectedProvider) {
    throw new Error('Connect a wallet first.');
  }

  await ensureBaseSepolia(selectedProvider);

  const recipientInput =
    $('recipient-address').value.trim();

  const amountInput =
    $('transfer-amount').value.trim();

  if (!isAddress(recipientInput)) {
    throw new Error(
      'Enter a valid recipient wallet address.'
    );
  }

  if (
    !/^\d+(\.\d{1,6})?$/.test(amountInput) ||
    Number(amountInput) <= 0
  ) {
    throw new Error(
      'Enter a positive USDC amount with no more than 6 decimal places.'
    );
  }

  const recipient = getAddress(recipientInput);

  if (
    recipient.toLowerCase() ===
    activeAccount.toLowerCase()
  ) {
    throw new Error(
      'Recipient must be different from the connected sender.'
    );
  }

  const amount = parseUnits(
    amountInput,
    tokenDecimals
  );

  const [freshBalance, ethBalance] =
    await Promise.all([
      publicClient.readContract({
        address: BASE_SEPOLIA_USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [activeAccount],
      }),

      publicClient.getBalance({
        address: activeAccount,
      }),
    ]);

  if (freshBalance < amount) {
    throw new Error('Insufficient USDC balance.');
  }

  if (ethBalance === 0n) {
    throw new Error(
      'No Base Sepolia ETH is available to pay gas.'
    );
  }

  const readableAmount = formatUnits(
    amount,
    tokenDecimals
  );

  const approved = window.confirm(
    `Send ${readableAmount} test USDC?\n\n` +
    `From: ${activeAccount}\n` +
    `To: ${recipient}\n` +
    `Network: Base Sepolia\n\n` +
    `Your selected wallet will ask you to sign.`
  );

  if (!approved) return;

  $('send-transfer').disabled = true;

  $('send-transfer').textContent =
    'Preparing transaction…';

  const resultPanel = $('live-transaction');

  resultPanel.classList.remove('hidden');

  resultPanel.textContent =
    'Simulating token transfer…';

  try {
    const simulation = await publicClient.simulateContract({
      account: activeAccount,
      address: BASE_SEPOLIA_USDC,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [recipient, amount],
    });

    if (simulation.result !== true) {
      throw new Error(
        'USDC transfer simulation did not succeed.'
      );
    }

    $('send-transfer').textContent =
      'Confirm in your wallet…';

    resultPanel.textContent =
      'Simulation passed. Confirm the transaction in your selected wallet.';

    // This uses the explicitly selected provider.
    const hash = await walletClient.writeContract(
      simulation.request
    );

    resultPanel.innerHTML = '';

    const pending = document.createElement('p');

    pending.textContent =
      'Transaction submitted. Waiting for confirmation…';

    const hashText = document.createElement('code');
    hashText.textContent = hash;

    const link = document.createElement('a');

    link.href =
      `https://sepolia.basescan.org/tx/${hash}`;

    link.target = '_blank';
    link.rel = 'noopener noreferrer';

    link.textContent =
      'Open transaction on BaseScan ↗';

    resultPanel.append(
      pending,
      hashText,
      document.createElement('br'),
      link
    );

    const receipt =
      await publicClient.waitForTransactionReceipt({
        hash,
      });

    const status = document.createElement('p');

    status.textContent =
      receipt.status === 'success'
        ? `Confirmed in block ${receipt.blockNumber}. Gas used: ${receipt.gasUsed}.`
        : 'Transaction reverted.';

    resultPanel.append(status);

    if (receipt.status !== 'success') {
      throw new Error(
        'The transaction was included but reverted.'
      );
    }

    await readBalances();

    setMessage(
      'transfer-message',
      'Transfer confirmed on Base Sepolia. The transaction link is available above.',
      'success'
    );

  } catch (error) {
    resultPanel.classList.remove('hidden');

    const errorText = document.createElement('p');

    errorText.textContent =
      error.shortMessage || error.message || 'Transfer failed.';

    resultPanel.append(errorText);

    throw error;

  } finally {
    $('send-transfer').disabled = !activeAccount;

    $('send-transfer').textContent =
      'Review and send test USDC';
  }
}

// --------------------------------------------------
// USER INTERACTIONS
// --------------------------------------------------

$('wallet-select').addEventListener('change', () => {
  clearWalletSession(
    'Wallet selection changed. Connect the selected wallet.'
  );

  $('connect-wallet').disabled =
    !$('wallet-select').value;

  $('connect-wallet').textContent =
    $('wallet-select').value
      ? 'Connect selected wallet'
      : 'Select a wallet first';
});

$('connect-wallet').addEventListener('click', async () => {
  try {
    await connectWallet();
  } catch (error) {
    setMessage(
      'wallet-message',
      error.shortMessage || error.message,
      'error'
    );
  }
});

$('refresh-wallets').addEventListener(
  'click',
  detectWallets
);

$('refresh-balances').addEventListener(
  'click',
  async () => {
    try {
      await readBalances();
    } catch (error) {
      setMessage(
        'wallet-message',
        error.shortMessage || error.message,
        'error'
      );
    }
  }
);

$('quote-form').addEventListener(
  'submit',
  compareQuotes
);

$('transfer-form').addEventListener(
  'submit',
  async (event) => {
    try {
      await sendUsdc(event);
    } catch (error) {
      setMessage(
        'transfer-message',
        error.shortMessage || error.message || 'Transfer failed.',
        'error'
      );
    }
  }
);

$('copy-hash').addEventListener('click', async () => {
  const hash = $('previous-hash').textContent.trim();

  try {
    await navigator.clipboard.writeText(hash);
    $('copy-hash').textContent = 'Copied';
  } catch {
    $('copy-hash').textContent = 'Copy unavailable';
  }
});

// --------------------------------------------------
// PAGE INITIALISATION
// --------------------------------------------------


async function initialise() {
  // Reset the application UI whenever the page loads.
  clearWalletSession(
    'Not connected. Select a wallet and click Connect Wallet.'
  );

  $('wallet-select').value = '';
  $('connect-wallet').disabled = true;
  $('connect-wallet').textContent = 'Select a wallet first';

  // Check the public RPC connection only.
  try {
    const chainId = await publicClient.getChainId();

    if (chainId === EXPECTED_CHAIN_ID) {
      $('rpc-status').textContent = 'Base RPC connected';
      $('rpc-detail').textContent =
        'Base Sepolia · Chain ID 84532';
    } else {
      $('rpc-status').textContent = 'Unexpected chain';
      $('rpc-detail').textContent =
        `Received Chain ID ${chainId}`;
    }
  } catch (error) {
    $('rpc-status').textContent = 'RPC connection unavailable';
    $('rpc-detail').textContent =
      error.shortMessage || error.message;
  }

  // Do not discover or connect wallets automatically.
  renderWalletOptions();

  await compareQuotes(
    new Event('submit', { cancelable: true })
  );
}

initialise();
