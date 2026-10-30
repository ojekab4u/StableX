
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatEther,
} from "https://esm.sh/viem@2.57.12";

import {
  baseSepolia,
} from "https://esm.sh/viem@2.57.12/chains";

// ========================================
// 1. CONTRACT CONFIGURATION
// ========================================

const CONTRACT_ADDRESS =
  "0x8d81e0d3e58af36404a9f1223f9858430f4f8073";

const BASE_CHAIN_ID = 84532;
const BASE_CHAIN_HEX = "0x14a34";

const CONTRACT_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "storedNumber",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setNumber",
    stateMutability: "nonpayable",
    inputs: [
      { name: "newNumber", type: "uint256" },
    ],
    outputs: [],
  },
];

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http("https://sepolia.base.org"),
});

// ========================================
// 2. APPLICATION STATE
// ========================================

const discoveredWallets = [];

let walletCounter = 0;

let activeProvider = null;
let activeWalletId = null;
let activeWalletName = null;
let walletAddress = null;
let contractOwner = null;
let walletClient = null;

let accountsChangedHandler = null;
let chainChangedHandler = null;

// ========================================
// 3. FRONTEND ELEMENTS
// ========================================

const walletSelect = document.querySelector(
  "#base-wallet-select"
);

const refreshButton = document.querySelector(
  "#refresh-base-wallets"
);

const connectButton = document.querySelector(
  "#connect-base-wallet"
);

const updateButton = document.querySelector(
  "#base-update-number"
);

const walletStatus = document.querySelector(
  "#base-wallet-status"
);

const walletDetails = document.querySelector(
  "#base-wallet-details"
);

const providerElement = document.querySelector(
  "#base-wallet-provider"
);

const walletAddressElement = document.querySelector(
  "#base-wallet-address"
);

const ownerElement = document.querySelector(
  "#base-contract-owner"
);

const balanceElement = document.querySelector(
  "#base-wallet-balance"
);

const storedNumberElement = document.querySelector(
  "#base-stored-number"
);

const newNumberInput = document.querySelector(
  "#base-new-number"
);

const walletMessage = document.querySelector(
  "#base-wallet-message"
);

// ========================================
// 4. DISPLAY HELPERS
// ========================================

function shortenAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function showWalletStatus(message, className = "") {
  walletStatus.textContent = message;
  walletStatus.className = `message ${className}`;
}

function showWalletMessage(message, className = "") {
  walletMessage.replaceChildren(
    document.createTextNode(message)
  );

  walletMessage.className = `message ${className}`;
}

function addTransactionLink(hash) {
  const link = document.createElement("a");

  link.href = `https://sepolia.basescan.org/tx/${hash}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "View transaction on BaseScan";

  walletMessage.append(
    document.createTextNode(" "),
    link
  );
}

// ========================================
// 5. WALLET DISCOVERY
// EIP-6963 MULTI-WALLET SUPPORT
// ========================================

function upsertWallet(info, provider) {
  if (!provider || typeof provider.request !== "function") {
    return;
  }

  const existing = discoveredWallets.find(
    (wallet) =>
      wallet.provider === provider ||
      (
        info.uuid &&
        wallet.info.uuid === info.uuid
      )
  );

  if (existing) {
    existing.info = {
      ...existing.info,
      ...info,
    };

    renderWalletOptions();
    return;
  }

  walletCounter++;

  discoveredWallets.push({
    id: info.uuid || `legacy-${walletCounter}`,
    info,
    provider,
  });

  renderWalletOptions();
}

// Listen for wallet announcements.


window.addEventListener(
  "eip6963:announceProvider",
  (event) => {
    const detail = event.detail;

    if (!detail?.info || !detail?.provider) {
      return;
    }

    upsertWallet(
      detail.info,
      detail.provider
    );
  }
);

// Legacy wallet detection.
// Used only as a fallback for providers that do not
// announce themselves through EIP-6963.

function getLegacyWalletName(provider) {
  if (provider.isRainbow) return "Rainbow Wallet";
  if (provider.isMetaMask) return "MetaMask";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isRabby) return "Rabby Wallet";
  if (provider.isBraveWallet) return "Brave Wallet";
  if (provider.isTrust) return "Trust Wallet";

  return "Browser Wallet";
}

function addLegacyWallets() {
  const legacyProviders = [];

  if (Array.isArray(window.ethereum?.providers)) {
    legacyProviders.push(...window.ethereum.providers);
  }

  if (
    window.ethereum &&
    !legacyProviders.includes(window.ethereum)
  ) {
    legacyProviders.push(window.ethereum);
  }

  legacyProviders.forEach((provider) => {
    upsertWallet(
      {
        name: getLegacyWalletName(provider),
        uuid: undefined,
        rdns: undefined,
      },
      provider
    );
  });
}

function renderWalletOptions() {
  const previousSelection = walletSelect.value;

  walletSelect.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a wallet...";

  walletSelect.appendChild(placeholder);

  discoveredWallets.forEach((wallet) => {
    const option = document.createElement("option");

    option.value = wallet.id;

    option.textContent = wallet.info.name ||
      "Browser Wallet";

    walletSelect.appendChild(option);
  });

  const selectionStillExists = discoveredWallets.some(
    (wallet) => wallet.id === previousSelection
  );

  walletSelect.value = selectionStillExists
    ? previousSelection
    : "";

  connectButton.disabled = !walletSelect.value;

  if (discoveredWallets.length === 0) {
    showWalletStatus(
      "No wallet detected. Install or enable a compatible wallet, then refresh."
    );
  } else {
    showWalletStatus(
      `${discoveredWallets.length} wallet(s) detected. Select your preferred wallet.`
    );
  }
}

async function discoverWallets() {
  showWalletStatus("Searching for available wallets...");

  // Ask all EIP-6963-compatible wallets to announce themselves.
  window.dispatchEvent(
    new Event("eip6963:requestProvider")
  );

  // Give browser extensions time to announce.
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });

  // Add legacy providers if they are exposed.
  addLegacyWallets();

  renderWalletOptions();
}

// ========================================
// 6. WALLET SELECTION
// ========================================

function getSelectedWallet() {
  return discoveredWallets.find(
    (wallet) => wallet.id === walletSelect.value
  );
}

function removeProviderListeners() {
  if (!activeProvider) return;

  if (accountsChangedHandler) {
    activeProvider.removeListener?.(
      "accountsChanged",
      accountsChangedHandler
    );
  }

  if (chainChangedHandler) {
    activeProvider.removeListener?.(
      "chainChanged",
      chainChangedHandler
    );
  }

  accountsChangedHandler = null;
  chainChangedHandler = null;
}

function clearWalletSession(message) {
  removeProviderListeners();

  activeProvider = null;
  activeWalletId = null;
  activeWalletName = null;
  walletAddress = null;
  contractOwner = null;
  walletClient = null;

  walletDetails.hidden = true;

  connectButton.textContent = "Connect Selected Wallet";
  connectButton.disabled = !walletSelect.value;

  updateButton.disabled = true;

  showWalletStatus(message);
}

walletSelect.addEventListener("change", () => {
  const selectedWallet = getSelectedWallet();

  connectButton.disabled = !selectedWallet;

  if (
    activeWalletId &&
    activeWalletId !== walletSelect.value
  ) {
    clearWalletSession(
      "Wallet selection changed. Connect your newly selected wallet."
    );
  }
});

refreshButton.addEventListener(
  "click",
  discoverWallets
);

// ========================================
// 7. BASE SEPOLIA NETWORK
// ========================================

async function ensureBaseSepolia(provider) {
  let chainId = await provider.request({
    method: "eth_chainId",
  });

  if (chainId.toLowerCase() === BASE_CHAIN_HEX) {
    return;
  }

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [
        { chainId: BASE_CHAIN_HEX },
      ],
    });
  } catch (error) {
    if (error.code !== 4902) {
      throw error;
    }

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: BASE_CHAIN_HEX,
          chainName: "Base Sepolia",
          nativeCurrency: {
            name: "ETH",
            symbol: "ETH",
            decimals: 18,
          },
          rpcUrls: ["https://sepolia.base.org"],
          blockExplorerUrls: [
            "https://sepolia.basescan.org",
          ],
        },
      ],
    });
  }

  chainId = await provider.request({
    method: "eth_chainId",
  });

  if (chainId.toLowerCase() !== BASE_CHAIN_HEX) {
    throw new Error(
      "Please switch your selected wallet to Base Sepolia."
    );
  }
}

// ========================================
// 8. READ CONTRACT INFORMATION
// ========================================

async function loadContractInformation() {
  const [owner, storedNumber, balance] =
    await Promise.all([
      publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: "owner",
      }),

      publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: "storedNumber",
      }),

      publicClient.getBalance({
        address: walletAddress,
      }),
    ]);

  contractOwner = owner;

  providerElement.textContent = activeWalletName;

  walletAddressElement.textContent =
    shortenAddress(walletAddress);

  ownerElement.textContent =
    shortenAddress(owner);

  balanceElement.textContent =
    `${formatEther(balance)} ETH`;

  storedNumberElement.textContent =
    storedNumber.toString();

  const isOwner =
    walletAddress.toLowerCase() ===
    owner.toLowerCase();

  updateButton.disabled = !isOwner;

  showWalletMessage(
    isOwner
      ? "Your connected wallet is the contract owner. You can update the number."
      : "This wallet can read the contract, but only the owner can update it."
  );
}

// ========================================
// 9. PROVIDER EVENT LISTENERS
// ========================================

function attachProviderListeners(provider) {
  removeProviderListeners();

  accountsChangedHandler = async (accounts) => {
    if (!accounts || accounts.length === 0) {
      clearWalletSession("Wallet disconnected.");
      return;
    }

    walletAddress = accounts[0];

    walletClient = createWalletClient({
      account: walletAddress,
      chain: baseSepolia,
      transport: custom(provider),
    });

    try {
      await loadContractInformation();
      showWalletStatus("Wallet account updated.", "status-ok");
    } catch (error) {
      showWalletStatus(error.message, "status-error");
    }
  };

  chainChangedHandler = async (chainId) => {
    if (chainId.toLowerCase() !== BASE_CHAIN_HEX) {
      walletClient = null;
      updateButton.disabled = true;

      showWalletStatus(
        "Your wallet changed networks. Switch back to Base Sepolia.",
        "status-error"
      );

      return;
    }

    if (!walletAddress) return;

    walletClient = createWalletClient({
      account: walletAddress,
      chain: baseSepolia,
      transport: custom(provider),
    });

    try {
      await loadContractInformation();
      showWalletStatus("Connected to Base Sepolia.", "status-ok");
    } catch (error) {
      showWalletStatus(error.message, "status-error");
    }
  };

  provider.on?.(
    "accountsChanged",
    accountsChangedHandler
  );

  provider.on?.(
    "chainChanged",
    chainChangedHandler
  );
}

// ========================================
// 10. CONNECT SELECTED WALLET
// ========================================

async function connectWallet() {
  const selectedWallet = getSelectedWallet();

  if (!selectedWallet) {
    showWalletStatus(
      "Please select a wallet before connecting."
    );
    return;
  }

  const provider = selectedWallet.provider;

  try {
    connectButton.disabled = true;

    showWalletStatus(
      `Connecting to ${selectedWallet.info.name}...`
    );

    const accounts = await provider.request({
      method: "eth_requestAccounts",
    });

    if (!accounts || accounts.length === 0) {
      throw new Error(
        "No wallet account was selected."
      );
    }

    await ensureBaseSepolia(provider);

    walletAddress = accounts[0];
    activeProvider = provider;
    activeWalletId = selectedWallet.id;
    activeWalletName = selectedWallet.info.name ||
      "Browser Wallet";

    walletClient = createWalletClient({
      account: walletAddress,
      chain: baseSepolia,
      transport: custom(provider),
    });

    const chainId = await publicClient.getChainId();

    if (chainId !== BASE_CHAIN_ID) {
      throw new Error(
        "Base Sepolia RPC connection failed."
      );
    }

    const bytecode = await publicClient.getCode({
      address: CONTRACT_ADDRESS,
    });

    if (!bytecode || bytecode === "0x") {
      throw new Error(
        "No deployed contract found at the configured address."
      );
    }

    attachProviderListeners(provider);

    await loadContractInformation();

    walletDetails.hidden = false;

    connectButton.textContent =
      `${activeWalletName} Connected`;

    showWalletStatus(
      `Successfully connected to ${activeWalletName} on Base Sepolia.`,
      "status-ok"
    );
  } catch (error) {
    clearWalletSession(
      error.shortMessage || error.message
    );

    showWalletStatus(
      error.shortMessage || error.message,
      "status-error"
    );
  } finally {
    connectButton.disabled = !walletSelect.value;
  }
}

// ========================================
// 11. WRITE TO SMART CONTRACT
// ========================================

async function updateContract() {
  try {
    if (!walletClient || !activeProvider) {
      throw new Error("Connect your wallet first.");
    }

    await ensureBaseSepolia(activeProvider);

    const currentAccounts = await activeProvider.request({
      method: "eth_accounts",
    });

    if (
      !currentAccounts?.[0] ||
      currentAccounts[0].toLowerCase() !==
        walletAddress.toLowerCase()
    ) {
      throw new Error(
        "The selected wallet account has changed. Reconnect your wallet."
      );
    }

    if (
      !contractOwner ||
      walletAddress.toLowerCase() !==
        contractOwner.toLowerCase()
    ) {
      throw new Error(
        "Only the contract owner can update this number."
      );
    }

    const rawValue = newNumberInput.value.trim();
    const numericValue = Number(rawValue);

    if (
      rawValue === "" ||
      !Number.isSafeInteger(numericValue) ||
      numericValue < 0
    ) {
      throw new Error(
        "Enter a valid non-negative whole number."
      );
    }

    updateButton.disabled = true;

    showWalletMessage(
      "Please review and approve the transaction in your selected wallet..."
    );

    const hash = await walletClient.writeContract({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: "setNumber",
      args: [BigInt(numericValue)],
    });

    showWalletMessage(
      "Transaction submitted. Waiting for confirmation..."
    );

    addTransactionLink(hash);

    const receipt =
      await publicClient.waitForTransactionReceipt({
        hash,
      });

    if (receipt.status !== "success") {
      throw new Error("The transaction failed.");
    }

    await loadContractInformation();

    showWalletMessage(
      `Transaction confirmed! storedNumber is now ${storedNumberElement.textContent}.`,
      "wallet-success"
    );

    addTransactionLink(hash);
  } catch (error) {
    showWalletMessage(
      error.shortMessage || error.message,
      "wallet-error"
    );
  } finally {
    updateButton.disabled =
      !walletAddress ||
      !contractOwner ||
      walletAddress.toLowerCase() !==
        contractOwner.toLowerCase();
  }
}

// ========================================
// 12. BUTTON EVENTS
// ========================================

connectButton.addEventListener(
  "click",
  connectWallet
);

updateButton.addEventListener(
  "click",
  updateContract
);

// ========================================
// 13. INITIALIZE
// ========================================

discoverWallets();
