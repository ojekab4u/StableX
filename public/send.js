const form = document.querySelector("#send-form");
const fromSelect = document.querySelector("#send-from");
const toSelect = document.querySelector("#send-to");
const amountInput = document.querySelector("#send-amount");
const recipientType = document.querySelector("#recipient-type");
const recipientInput = document.querySelector("#recipient-reference");
const recipientLabel = document.querySelector("#recipient-label");
const recipientHelp = document.querySelector("#recipient-help");
const routeStatus = document.querySelector("#route-status");
const message = document.querySelector("#send-message");
const createButton = document.querySelector("#create-draft");
const draftPanel = document.querySelector("#draft-panel");
const draftResult = document.querySelector("#draft-result");

let currentRoute = null;

async function loadIntegrationReadiness() {
  const summary = document.querySelector("#readiness-summary");
  if (!summary) return;
  try {
    const response = await fetch("/api/send/readiness");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Readiness check failed.");
    summary.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = "Integration configuration overview";
    const details = document.createElement("p");
    details.textContent = data.note;
    const list = document.createElement("ul");
    data.integrations.forEach(item => {
      const entry = document.createElement("li");
      entry.textContent = `${item.name}: ${item.status.replaceAll("_", " ")}`;
      list.append(entry);
    });
    summary.append(heading, details, list);
  } catch (error) {
    summary.textContent = error.message;
  }
}

async function loadRoutes() {
  try {
    const [routeResponse, assetResponse] = await Promise.all([
      fetch("/api/send/routes"), fetch("/api/assets")
    ]);
    const routeData = await routeResponse.json();
    const assetData = await assetResponse.json();
    if (!routeResponse.ok || !assetResponse.ok) throw new Error("Unable to load configured assets and routes.");
    const routes = routeData.routes || [];
    const assets = assetData.assets || [];
    const codes = [...new Set(routes.flatMap(route => [route.from, route.to]))];
    const options = codes.map(code => {
      const asset = assets.find(item => item.code === code);
      return { code, label: asset ? asset.name : code };
    });
    fromSelect.replaceChildren();
    toSelect.replaceChildren();
    options.forEach(asset => {
      fromSelect.add(new Option(`${asset.code} — ${asset.label}`, asset.code));
      toSelect.add(new Option(`${asset.code} — ${asset.label}`, asset.code));
    });
    fromSelect.value = "NGN";
    toSelect.value = "CADC";
    await checkAvailability();
  } catch (error) {
    routeStatus.textContent = error.message;
    message.textContent = error.message;
  }
}

async function checkAvailability() {
  const from = fromSelect.value;
  const to = toSelect.value;
  if (!from || !to || from === to) {
    currentRoute = null;
    createButton.disabled = true;
    routeStatus.textContent = "Choose two different currencies.";
    return;
  }
  try {
    const params = new URLSearchParams({ from, to });
    const response = await fetch(`/api/send/availability?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Route check failed.");
    currentRoute = data.route;
    createButton.disabled = !currentRoute.supported;
    routeStatus.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = currentRoute.supported
      ? `${from} → ${to}: configured route`
      : `${from} → ${to}: route not configured`;
    const explanation = document.createElement("p");
    explanation.textContent = currentRoute.reason || "No route information available.";
    const state = document.createElement("p");
    state.className = "muted";
    state.textContent = currentRoute.supported
      ? "This confirms only that the route is listed in StableX. It does not check live liquidity, a provider quote or payout availability."
      : "Choose a route listed in StableX.";
    routeStatus.append(heading, explanation, state);
  } catch (error) {
    currentRoute = null;
    createButton.disabled = true;
    routeStatus.textContent = error.message;
  }
}

function updateRecipientInput() {
  const isWallet = recipientType.value === "WALLET";
  recipientLabel.textContent = isWallet ? "Recipient wallet address" : "Beneficiary / payout ID";
  recipientInput.placeholder = isWallet ? "0x..." : "Enter the identifier required by the payout institution";
  recipientHelp.textContent = isWallet
    ? "Enter the recipient's Base-compatible wallet address."
    : "Use the beneficiary or payout identifier supplied by the financial institution. The exact format depends on its API.";
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentRoute?.supported) {
    message.textContent = "Check a configured route before creating a draft.";
    return;
  }
  createButton.disabled = true;
  message.textContent = "Creating transfer draft…";
  try {
    const response = await fetch("/api/send/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromSelect.value, to: toSelect.value,
        amount: Number(amountInput.value), recipientType: recipientType.value,
        recipientReference: recipientInput.value.trim()
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create transfer draft.");
    renderDraft(data.draft);
    message.textContent = data.message;
  } catch (error) {
    message.textContent = error.message;
  } finally {
    createButton.disabled = !currentRoute?.supported;
  }
});

function renderDraft(draft) {
  draftPanel.hidden = false;
  draftResult.replaceChildren();
  const rows = [
    ["Draft reference", draft.draftId],
    ["Transfer", `${draft.amount} ${draft.from} → ${draft.to}`],
    ["Recipient destination", draft.recipientType === "WALLET" ? "Base-compatible wallet" : "Financial institution payout"],
    [draft.recipientType === "WALLET" ? "Wallet address" : "Beneficiary / payout ID", draft.recipientReference],
    ["Status", draft.status],
    ["Execution", "DISABLED — no funds moved"]
  ];
  rows.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "detail-row";
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("strong");
    val.textContent = value;
    row.append(key, val);
    draftResult.append(row);
  });
  const note = document.createElement("p");
  note.className = "notice";
  note.textContent = draft.nextAction;
  draftResult.append(note);
}

fromSelect.addEventListener("change", checkAvailability);
toSelect.addEventListener("change", checkAvailability);
document.querySelector("#check-route").addEventListener("click", checkAvailability);
recipientType.addEventListener("change", updateRecipientInput);
updateRecipientInput();
loadRoutes();
loadIntegrationReadiness();
