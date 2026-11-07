const cards = document.querySelector("#provider-cards");
const updated = document.querySelector("#readiness-updated");
const form = document.querySelector("#provider-quote-form");
const results = document.querySelector("#provider-quote-results");
const submitButton = document.querySelector("#request-provider-quotes");
const progress = document.querySelector("#quote-progress");

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readinessLabel(provider) {
  if (provider.configured) return ["Credentials present — test connection", "ready"];
  return ["Credentials required", "missing"];
}

async function loadReadiness() {
  cards.replaceChildren(makeElement("p", "provider-muted", "Checking server configuration…"));
  try {
    const response = await fetch("/api/providers/readiness", { headers: { accept: "application/json" } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to retrieve provider readiness.");
    cards.replaceChildren();
    for (const provider of data.providers || []) {
      const card = makeElement("article", "provider-card");
      const top = makeElement("div", "provider-card-top");
      top.append(makeElement("h3", "", provider.name));
      const [label, tone] = readinessLabel(provider);
      top.append(makeElement("span", `provider-status ${tone}`, label));
      card.append(top);
      card.append(makeElement("p", "", provider.note || provider.status || "Provider configuration status."));
      const list = makeElement("ul");
      for (const capability of provider.capabilities || []) list.append(makeElement("li", "", capability.replaceAll("_", " ").toLowerCase()));
      for (const missing of provider.missingVariables || []) list.append(makeElement("li", "", `Missing: ${missing}`));
      if (!provider.missingVariables?.length) list.append(makeElement("li", "", "Required environment values detected; connection not yet verified."));
      card.append(list);
      cards.append(card);
    }
    for (const partner of data.partners?.friendly || []) {
      const card = makeElement("article", "provider-card");
      const top = makeElement("div", "provider-card-top");
      top.append(makeElement("h3", "", partner.name));
      top.append(makeElement("span", `provider-status ${partner.configured ? "ok" : "warn"}`, partner.configured ? "Credentials present" : "Awaiting credentials"));
      card.append(top);
      card.append(makeElement("p", "", `${partner.role}. ${partner.docsUrl}`));
      const list = makeElement("ul");
      for (const corridor of partner.corridors || []) list.append(makeElement("li", "", `Corridor: ${corridor.toLowerCase()}`));
      for (const capability of partner.capabilities || []) list.append(makeElement("li", "", capability.replaceAll("_", " ").toLowerCase()));
      for (const task of partner.configurationTasks || []) list.append(makeElement("li", "", `Task: ${task.replace(/_/g, " ").toLowerCase()}`));
      for (const question of partner.openQuestions || []) list.append(makeElement("li", "", `Question: ${question.replace(/_/g, " ").toLowerCase()}`));
      for (const missing of partner.missingVariables || []) list.append(makeElement("li", "", `Missing: ${missing}`));
      card.append(list);
      cards.append(card);
    }
    updated.textContent = `Last checked: ${new Date().toLocaleTimeString()} · Execution enabled: no`;
  } catch (error) {
    cards.replaceChildren(makeElement("p", "provider-muted", error.message));
    updated.textContent = "Readiness check failed.";
  }
}

function renderQuoteResult(result) {
  const card = makeElement("article", `provider-result ${result.available ? "" : "failed"}`);
  const title = makeElement("h3", "", result.provider);
  card.append(title);
  if (!result.available) {
    card.append(makeElement("p", "result-state", "Rate preview unavailable"));
    card.append(makeElement("p", "", result.error || "Provider request failed."));
    return card;
  }
  card.append(makeElement("p", "result-state", "Indicative rate preview received"));
  const quote = result.quote || {};
  const data = quote.providerData || {};
  const summary = {
    quoteType: quote.quoteType,
    direction: quote.direction || "FX PREVIEW",
    from: quote.from,
    to: quote.to,
    amount: quote.amount,
    network: quote.network,
    providerData: data,
    executionEnabled: quote.executionEnabled,
    note: quote.note
  };
  const pre = makeElement("pre");
  pre.textContent = JSON.stringify(summary, null, 2);
  card.append(pre);
  return card;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());
  values.amount = Number(values.amount);
  values.from = values.from.trim().toUpperCase();
  values.to = values.to.trim().toUpperCase();
  values.network = values.network.trim().toLowerCase();

  if (!Number.isFinite(values.amount) || values.amount <= 0) {
    progress.textContent = "Enter an amount greater than zero.";
    return;
  }

  submitButton.disabled = true;
  progress.textContent = "Requesting provider rate previews…";
  results.replaceChildren(makeElement("p", "provider-muted", "Waiting for provider responses…"));
  try {
    const response = await fetch("/api/providers/quotes", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(values)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Provider rate request failed.");
    results.replaceChildren();
    for (const result of data.results || []) results.append(renderQuoteResult(result));
    if (!data.results?.length) results.append(makeElement("p", "provider-muted", "No provider results returned."));
    progress.textContent = "Completed · no order or transfer was created.";
  } catch (error) {
    results.replaceChildren(makeElement("p", "provider-muted", error.message));
    progress.textContent = "Request failed.";
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#refresh-readiness").addEventListener("click", loadReadiness);
loadReadiness();
