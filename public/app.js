
const form = document.querySelector("#quote-form");
const amountInput = document.querySelector("#amount");
const fromSelect = document.querySelector("#from");
const toSelect = document.querySelector("#to");
const reverseButton = document.querySelector("#reverse");
const compareButton = document.querySelector("#compare");
const offersContainer = document.querySelector("#offers");
const message = document.querySelector("#message");
const selectionContainer = document.querySelector("#selection");
const solanaStatus = document.querySelector("#solana-status");
const refreshSolanaButton = document.querySelector("#refresh-solana");

let currentQuotes = [];
let selectedQuoteId = null;
let selectedQuoteContext = null;

const currencyNames = {
  USDT: "USDT",
  USDC: "USDC",
  NGN: "NGN"
};

function formatAmount(value, currency) {
  const maximumFractionDigits = currency === "NGN" ? 2 : 6;

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits
  }).format(value);
}

function clearSelection() {
  selectedQuoteId = null;
  renderSelection();
}

async function loadQuotes() {
  const amount = Number(amountInput.value);
  const from = fromSelect.value;
  const to = toSelect.value;

  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    message.textContent = "Enter an amount greater than zero and at most 1,000,000.";
    return;
  }

  if (from === to) {
    message.textContent = "Choose two different currencies.";
    return;
  }

  compareButton.disabled = true;
  message.textContent = "Comparing provider offers...";

  try {
    const params = new URLSearchParams({
      amount: String(amount),
      from,
      to
    });

    const response = await fetch(`/api/quotes?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to retrieve quotes.");
    }

    currentQuotes = data.quotes;
    selectedQuoteContext = { amount, from, to };
    clearSelection();
    renderQuotes();

    message.textContent =
      "Demo offers loaded. Rates are simulated, not live market prices.";
  } catch (error) {
    offersContainer.textContent = "Could not load provider offers.";
    message.textContent = error.message;
  } finally {
    compareButton.disabled = false;
  }
}


function renderQuotes() {
  offersContainer.replaceChildren();

  if (!currentQuotes.length) {
    offersContainer.textContent = "No offers available.";
    return;
  }

  currentQuotes.forEach((quote, index) => {
    const isSelected = quote.id === selectedQuoteId;

    const card = document.createElement("article");
    card.className = "offer-card";
    
    // Highlight only the currently selected provider.
    card.classList.toggle("chosen-offer", isSelected);

    const rank = document.createElement("span");
    rank.className = "rank-tag";
    rank.textContent = index === 0 ? "BEST DEMO OFFER" : "DEMO OFFER";

    const title = document.createElement("h3");
    title.textContent = quote.provider;

    const netLabel = document.createElement("div");
    netLabel.className = "net-label";
    netLabel.textContent = "Estimated amount received";

    const netAmount = document.createElement("div");
    netAmount.className = "net-amount";
    netAmount.textContent =
      `${formatAmount(quote.netAmount, quote.to)} ${quote.to}`;

    const details = document.createElement("div");
    details.className = "details";

    const detailRows = [
      [
        "Exchange rate",
        `${formatAmount(quote.rate, quote.to)} ${quote.to} / ${quote.from}`
      ],
      [
        "Gross amount",
        `${formatAmount(quote.grossAmount, quote.to)} ${quote.to}`
      ],
      [
        "Estimated fee",
        `${formatAmount(quote.fee, quote.feeCurrency)} ${quote.feeCurrency}`
      ],
      ["Processing time", quote.processingTime]
    ];

    detailRows.forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "detail-row";

      const labelElement = document.createElement("span");
      labelElement.textContent = label;

      const valueElement = document.createElement("strong");
      valueElement.textContent = value;

      row.append(labelElement, valueElement);
      details.append(row);
    });

    const button = document.createElement("button");
    button.type = "button";
    button.className = "choose-btn";
    button.dataset.quoteId = quote.id;
    button.textContent = isSelected ? "Selected" : "Choose provider";
    button.classList.toggle("chosen", isSelected);

    card.append(rank, title, netLabel, netAmount, details, button);
    offersContainer.append(card);
  });
}

// Register this listener only once, outside renderQuotes().
offersContainer.addEventListener("click", (event) => {
  const button = event.target.closest("button.choose-btn");

  if (!button || !offersContainer.contains(button)) {
    return;
  }

  const quoteId = button.dataset.quoteId;

  if (quoteId) {
    chooseProvider(quoteId);
  }
});



async function chooseProvider(quoteId) {
  const quote = currentQuotes.find(
    (item) => item.id === quoteId
  );

  if (!quote || !selectedQuoteContext) {
    message.textContent = "Please compare offers again.";
    return;
  }

  // Update the UI immediately.
  selectedQuoteId = quoteId;
  renderQuotes();
  renderSelection();

  message.textContent = `Selected ${quote.provider}. Recording demo selection...`;

  try {
    const response = await fetch("/api/selections", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        quoteId,
        ...selectedQuoteContext
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Could not record selection."
      );
    }

    const status = document.createElement("p");
    status.className = "muted";
    status.textContent =
      `Selection recorded: ${data.selection.selectionId}`;

    selectionContainer.append(status);

    message.textContent =
      `${quote.provider} selected successfully. Demo only; no transaction occurred.`;
  } catch (error) {
    message.textContent =
      `Provider selected locally, but saving failed: ${error.message}`;
  }
}

function renderSelection() {
  selectionContainer.replaceChildren();

  const quote = currentQuotes.find(item => item.id === selectedQuoteId);

  if (!quote) {
    const text = document.createElement("p");
    text.className = "muted";
    text.textContent = "Choose a provider from the offers above.";
    selectionContainer.append(text);
    return;
  }

  const heading = document.createElement("h3");
  heading.textContent = quote.provider;

  const amount = document.createElement("p");
  amount.textContent =
    `Estimated output: ${formatAmount(quote.netAmount, quote.to)} ${quote.to}`;

  const status = document.createElement("p");
  status.className = "muted";
  status.textContent =
    "Status: SELECTED DEMO. No trade or blockchain transaction was submitted.";

  selectionContainer.append(heading, amount, status);
}

async function checkSolana() {
  refreshSolanaButton.disabled = true;
  solanaStatus.className = "";
  solanaStatus.textContent = "Checking Solana Devnet...";

  try {
    const response = await fetch("/api/solana/status");
    const data = await response.json();

    if (!response.ok || !data.connected) {
      throw new Error(data.error || "Connection failed.");
    }

    solanaStatus.className = "status-ok";

    const statusText = document.createElement("p");
    statusText.textContent = "Connected to Solana Devnet.";

    const versionText = document.createElement("p");
    versionText.textContent = `Solana core version: ${data.coreVersion}`;

    const slotText = document.createElement("p");
    slotText.textContent = `Current slot: ${data.slot}`;

    solanaStatus.replaceChildren(statusText, versionText, slotText);
  } catch (error) {
    solanaStatus.className = "status-error";
    solanaStatus.textContent = `Unable to connect: ${error.message}`;
  } finally {
    refreshSolanaButton.disabled = false;
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  loadQuotes();
});

reverseButton.addEventListener("click", () => {
  const previousFrom = fromSelect.value;
  fromSelect.value = toSelect.value;
  toSelect.value = previousFrom;
  clearSelection();
});

refreshSolanaButton.addEventListener("click", checkSolana);

loadQuotes();
checkSolana();
