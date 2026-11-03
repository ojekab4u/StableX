const providerStatus = document.querySelector("#provider-status");
const form = document.querySelector("#kyb-form");
const message = document.querySelector("#kyb-message");
const result = document.querySelector("#kyb-result");

async function loadReadiness() {
  try {
    const response = await fetch("/api/kyb/readiness");
    const data = await response.json();
    providerStatus.textContent = data.configured
      ? `VOVE ${data.environment}: credentials present. Connection will be tested when a case is created.`
      : `VOVE ${data.environment}: waiting for server configuration (${data.missing.join(", ")}).`;
  } catch {
    providerStatus.textContent = "Unable to read VOVE integration configuration.";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#create-case");
  button.disabled = true;
  message.textContent = "Creating case with VOVE sandbox…";
  result.replaceChildren();
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    const response = await fetch("/api/kyb/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "VOVE case creation failed.");
    message.textContent = data.message;
    const card = document.createElement("div");
    card.className = "kyb-result";
    const details = document.createElement("p");
    details.textContent = `Reference: ${data.case.refId} | Status: ${data.case.status} | Environment: ${data.case.environment}`;
    const link = document.createElement("a");
    link.href = data.case.verificationUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open hosted VOVE verification session";
    const warning = document.createElement("p");
    warning.className = "kyb-note";
    warning.textContent = "This link is a sensitive, time-limited verification session. Do not share it publicly. A created case is not an approval.";
    card.append(details, link, warning);
    result.append(card);
    document.querySelector("#lookup-form [name=refId]").value = data.case.refId;
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#lookup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const refId = new FormData(event.currentTarget).get("refId");
  const target = document.querySelector("#lookup-result");
  target.textContent = "Loading…";
  try {
    const response = await fetch(`/api/kyb/cases/${encodeURIComponent(refId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not retrieve case.");
    target.textContent = `Provider: VOVE ID | Reference: ${data.case.refId} | Status: ${data.case.status} | Last updated: ${data.case.lastUpdatedAt}`;
  } catch (error) {
    target.textContent = error.message;
  }
});

loadReadiness();
