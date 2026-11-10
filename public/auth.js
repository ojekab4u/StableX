// StableX account flow: sign up -> verify email/phone -> KYC/KYB -> active.
// The session token is a prototype bearer token stored in localStorage; do not
// treat this as production session storage.
const TOKEN_KEY = "stablex_session";

const $ = (id) => document.getElementById(id);
const views = ["view-auth", "view-verify", "view-compliance", "view-done"];

let registeredCodes = {};   // demo codes returned by registration, keyed by channel
let pendingAccountId = null; // used before sign-in when verification is required
let complianceCaseId = null; // KYC/KYB case id for polling refresh
let complianceVerificationUrl = null; // hosted VOVE session URL for the user to open
let pollingTimeout = null;   // one scheduled refresh; avoids overlapping requests
let pollingActive = false;
let pollingInFlight = false;
let pollingDelayMs = 15000;

function show(viewId) {
  views.forEach((id) => $(id).classList.toggle("hidden", id !== viewId));
  $("session-footer").classList.toggle("hidden", viewId === "view-auth" || !getToken());
}

function showMessage(text, kind = "info") {
  const box = $("msg");
  box.textContent = text;
  box.className = `msg show ${kind}`;
}

function clearMessage() {
  $("msg").className = "msg";
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed.");
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

// ---------- view 1: auth ----------

let signupType = "PERSONAL";

function setSignupType(type) {
  signupType = type;
  $("type-personal").classList.toggle("active", type === "PERSONAL");
  $("type-business").classList.toggle("active", type === "BUSINESS");
  $("field-business-name").classList.toggle("hidden", type !== "BUSINESS");
}

function selectTab(tab) {
  $("tab-signin").classList.toggle("active", tab === "signin");
  $("tab-signup").classList.toggle("active", tab === "signup");
  $("form-signin").classList.toggle("hidden", tab !== "signin");
  $("form-signup").classList.toggle("hidden", tab !== "signup");
}

$("tab-signin").addEventListener("click", () => selectTab("signin"));
$("tab-signup").addEventListener("click", () => selectTab("signup"));
$("type-personal").addEventListener("click", () => setSignupType("PERSONAL"));
$("type-business").addEventListener("click", () => setSignupType("BUSINESS"));

$("form-signup").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();
  const button = event.submitter || event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(event.target).entries());
    const result = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ ...values, accountType: signupType }),
    });
    pendingAccountId = result.accountId;
    registeredCodes = {};
    for (const channel of Object.keys(result.verification || {})) {
      registeredCodes[channel.toUpperCase()] = result.verification[channel].demoCode || null;
    }
    const codes = Object.entries(result.verification || {})
      .map(([channel, info]) => `${channel}: ${info.demoCode ?? "(delivery provider not configured)"}`)
      .join(" | ");
    showMessage(`Account created. Demo verification codes — ${codes}`, "warn");
    renderVerifyView({ accountId: result.accountId });
    show("view-verify");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("form-signin").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();
  const button = event.submitter || event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(event.target).entries());
    const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify(values) });
    saveToken(result.token);
    await routeBySession();
  } catch (error) {
    if (error.status === 403 && error.data?.accountId) {
      pendingAccountId = error.data.accountId;
      showMessage(`${error.message} Verify below to continue.`, "warn");
      renderVerifyView({ accountId: error.data.accountId });
      show("view-verify");
    } else {
      showMessage(error.message, "error");
    }
  } finally {
    button.disabled = false;
  }
});

// ---------- view 2: verification ----------

function renderVerifyView({ accountId, session }) {
  const container = $("verify-channels");
  container.replaceChildren();
  const account = session?.account;
  pendingAccountId = accountId || account?.accountId || pendingAccountId;

  const channels = [];
  if (account) {
    if (!account.verification.emailVerified) channels.push({ channel: "EMAIL", label: "Email" });
    if (account.phone && !account.verification.phoneVerified) channels.push({ channel: "PHONE", label: "Phone" });
  } else {
    channels.push({ channel: "EMAIL", label: "Email" }, { channel: "PHONE", label: "Phone" });
  }

  if (!channels.length) return;

  channels.forEach(({ channel, label }) => {
    const row = document.createElement("div");
    row.className = "step-row";
    const demoCode = registeredCodes[channel];
    const info = document.createElement("div");
    info.innerHTML = `<strong>${label} verification</strong><small>${
      demoCode ? `Demo code: <span class="code-pill">${demoCode}</span>` : "Check your delivery provider; codes also appear in the server log."
    }</small>`;
    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;gap:8px;align-items:center";
    const input = document.createElement("input");
    input.placeholder = "000000";
    input.maxLength = 6;
    input.style.cssText = "width:96px;padding:10px;border:1px solid #cbd5e1;border-radius:8px";
    input.dataset.channel = channel;
    const verify = document.createElement("button");
    verify.className = "auth-btn";
    verify.type = "button";
    verify.textContent = "Verify";
    verify.addEventListener("click", () => submitCode(channel, input.value, verify));
    const resend = document.createElement("button");
    resend.className = "auth-btn secondary";
    resend.type = "button";
    resend.textContent = "Resend";
    resend.addEventListener("click", () => resendCode(channel, resend, info));
    controls.append(input, verify, resend);
    row.append(info, controls);
    container.append(row);
  });
  $("verify-badge").textContent = "PENDING";
  $("verify-badge").className = "badge wait";
}

async function submitCode(channel, code, button) {
  if (!/^\d{6}$/.test(code)) {
    showMessage("Enter the 6-digit code.", "error");
    return;
  }
  button.disabled = true;
  try {
    await api("/api/auth/verify/" + channel.toLowerCase(), {
      method: "POST",
      body: JSON.stringify({ accountId: pendingAccountId, code }),
    });
    showMessage(`${channel.toLowerCase()} verified.`, "success");
    await routeBySession();
  } catch (error) {
    showMessage(error.message, "error");
    button.disabled = false;
  }
}

async function resendCode(channel, button, info) {
  button.disabled = true;
  try {
    const result = await api("/api/auth/resend", {
      method: "POST",
      body: JSON.stringify({ accountId: pendingAccountId, channel }),
    });
    const verification = result.verification || {};
    registeredCodes[channel] = verification.demoCode || null;
    const small = info.querySelector("small");
    small.innerHTML = verification.demoCode
      ? `New demo code: <span class="code-pill">${verification.demoCode}</span>`
      : "New code issued via delivery provider; it also appears in the server log.";
    showMessage(`A new ${channel.toLowerCase()} code was issued; the old one no longer works.`, "info");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

$("verify-refresh").addEventListener("click", () => routeBySession());

// ---------- view 3: compliance (KYC / KYB) ----------

function renderComplianceView(session) {
  const { account, compliancePrefill, complianceOptions, complianceGate } = session;
  const isBusiness = account.accountType === "BUSINESS";
  $("compliance-title").firstChild.textContent = isBusiness ? "Business verification (KYB) " : "Identity verification (KYC) ";
  const badge = $("compliance-badge");
  badge.textContent = complianceGate.status;
  badge.className = `badge ${complianceGate.approved ? "ok" : complianceGate.status === "REJECTED" ? "bad" : "wait"}`;

  const mode = complianceOptions?.mode || "NOT_AVAILABLE";
  const modeBox = $("compliance-mode");
  modeBox.className = `msg show ${mode === "VOVE_HOSTED" ? "info" : mode === "LOCAL_SIMULATOR" ? "warn" : "error"}`;
  modeBox.textContent = {
    VOVE_HOSTED: "VOVE is configured: open the hosted VOVE verification session below, complete it, then StableX polls for approval.",
    LOCAL_SIMULATOR: "Simulator mode: no identity provider is configured, so a clearly labeled simulated case is created. Set VOVE credentials to switch to real hosted verification.",
    NOT_AVAILABLE: "No verification provider is available. Configure VOVE credentials or set COMPLIANCE_SIM_AUTO_APPROVE=true on the server.",
  }[mode];

  const fields = $("compliance-fields");
  fields.replaceChildren();
  const prefilled = [
    ["fullName", "Full legal name", true],
    ...(isBusiness ? [["businessName", "Business legal name", true]] : []),
    ["country", "Country (ISO-2)", true],
    ["dateOfBirth", "Date of birth", false],
    ["email", "Email", true],
    ["phone", "Phone", false],
  ];
  prefilled.forEach(([name, label, locked]) => {
    const field = document.createElement("label");
    field.className = "auth-field";
    const span = document.createElement("span");
    span.textContent = label + (locked ? " *" : "");
    const input = document.createElement("input");
    input.name = name;
    input.value = compliancePrefill?.[name] || "";
    if (locked) input.readOnly = true;
    field.append(span, input);
    fields.append(field);
  });
  if (isBusiness) {
    [["registrationNumber", "Registration number"], ["city", "City"], ["address", "Business address"]].forEach(([name, label]) => {
      const field = document.createElement("label");
      field.className = "auth-field";
      const span = document.createElement("span");
      span.textContent = label;
      const input = document.createElement("input");
      input.name = name;
      field.append(span, input);
      fields.append(field);
    });
  }
  $("compliance-submit").disabled = mode === "NOT_AVAILABLE";
  $("compliance-result").replaceChildren();

  complianceCaseId = complianceGate?.caseId || null;
  complianceVerificationUrl = session?.verificationUrl || null;

  // Always show the hosted VOVE link when there is a pending case, so the user
  // can open it themselves (browsers block auto-popups). It persists across
  // polls and page refreshes.
  if (complianceCaseId && mode === "VOVE_HOSTED") {
    const box = $("compliance-result");
    box.replaceChildren();
    const card = document.createElement("div");
    card.className = "msg show info";
    const label = document.createElement("p");
    label.textContent = "1. Open the hosted VOVE verification session and complete identity checks:";
    if (complianceVerificationUrl) {
      const link = document.createElement("a");
      link.href = complianceVerificationUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open VOVE verification session";
      link.className = "auth-btn";
      link.style.cssText = "display:inline-block;margin-top:8px;padding:12px 24px;font-size:1rem";
      card.append(label, link);
    } else {
      label.textContent = "Your VOVE verification case is already registered. Refresh the status below; a new hosted link may be required if the previous session expired.";
      card.append(label);
    }
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "StableX checks VOVE periodically and displays the latest provider response below.";
    card.append(hint);
    box.append(card);
    startPolling();
  } else if (complianceGate?.approved) {
    stopPolling();
    show("view-done");
  } else {
    stopPolling();
  }
}

$("form-compliance").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();
  const button = $("compliance-submit");
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(event.target).entries());
    const result = await api("/api/compliance/cases/self", { method: "POST", body: JSON.stringify(values) });

    // Store the hosted URL and case id so the link persists across polls.
    complianceCaseId = result.case?.caseId || null;
    complianceVerificationUrl = result.verificationUrl || null;

    const box = $("compliance-result");
    box.replaceChildren();
    if (result.verificationUrl) {
      const card = document.createElement("div");
      card.className = "msg show info";
      card.textContent = result.gateMessage;
      const link = document.createElement("a");
      link.href = result.verificationUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open hosted VOVE verification session";
      link.className = "auth-btn";
      link.style.cssText = "display:block;margin-top:10px;padding:12px 24px;font-size:1rem;max-width:420px";
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Browsers block auto-popups, so please click the link above to open VOVE in a new tab. StableX will poll for approval every second once you return.";
      card.append(link, hint);
      box.append(card);
    } else {
      box.textContent = result.gateMessage;
    }

    // Start polling immediately; the session refresh happens inside polling.
    if (complianceCaseId) {
      startPolling();
    }
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

function setComplianceSyncMessage(message, kind = "info") {
  const element = $("compliance-sync-status");
  if (!element) return;
  element.textContent = message;
  element.dataset.state = kind;
}

function scheduleCompliancePoll(delayMs = pollingDelayMs) {
  if (!pollingActive || !complianceCaseId) return;
  if (pollingTimeout) clearTimeout(pollingTimeout);
  pollingTimeout = setTimeout(() => {
    pollingTimeout = null;
    refreshComplianceStatus({ silent: true });
  }, delayMs);
}

// A single-flight refresh avoids overlapping provider requests. The customer
// sees both the provider result and the StableX gate, plus actionable errors.
async function refreshComplianceStatus({ silent = false } = {}) {
  if (!complianceCaseId) {
    setComplianceSyncMessage("No VOVE compliance case is linked to this account.", "warn");
    return;
  }
  if (pollingInFlight) return;
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
  pollingInFlight = true;
  try {
    const refreshed = await api(
      `/api/compliance/cases/${encodeURIComponent(complianceCaseId)}/refresh`,
      { method: "POST" }
    );
    const session = await api("/api/auth/session");
    const gate = session.complianceGate || {};
    const providerStatus = refreshed.providerStatus || "UNKNOWN";
    const stableStatus = gate.status || refreshed.complianceStatus || "PENDING";
    const badge = $("compliance-badge");
    badge.textContent = stableStatus;
    badge.className = `badge ${gate.approved ? "ok" : stableStatus === "REJECTED" ? "bad" : "wait"}`;

    const checkedAt = new Date().toLocaleString();
    const field = refreshed.providerStatusField ? `; field: ${refreshed.providerStatusField}` : "";
    const responseKeys = Array.isArray(refreshed.providerResponseKeys)
      ? `; response keys: ${refreshed.providerResponseKeys.join(", ") || "(none)"}`
      : "";
    setComplianceSyncMessage(
      `Last checked: ${checkedAt}. VOVE: ${providerStatus}${field}. StableX gate: ${stableStatus}${responseKeys}.`,
      gate.approved ? "success" : stableStatus === "REJECTED" ? "error" : "info"
    );

    if (gate.approved) {
      stopPolling();
      show("view-done");
      return;
    }
    if (stableStatus === "REJECTED") {
      stopPolling();
      showMessage("Verification was rejected. Please contact support.", "error");
      return;
    }
    pollingDelayMs = 15000;
    if (pollingActive) scheduleCompliancePoll();
  } catch (error) {
    console.error("[StableX compliance status refresh failed]", error.status, error.message);
    setComplianceSyncMessage(
      `Could not retrieve the latest VOVE status: ${error.message}. The saved StableX status has not been changed by this failed check.`,
      "error"
    );
    if (error.status === 401 || error.status === 404) {
      stopPolling();
    } else if (pollingActive) {
      pollingDelayMs = Math.min(Math.max(pollingDelayMs * 2, 30000), 120000);
      scheduleCompliancePoll(pollingDelayMs);
    }
    if (!silent) showMessage(error.message, "error");
  } finally {
    pollingInFlight = false;
  }
}

$("compliance-refresh").addEventListener("click", () => {
  refreshComplianceStatus({ silent: false });
});

function startPolling() {
  stopPolling();
  pollingActive = true;
  pollingDelayMs = 15000;
  setComplianceSyncMessage("Checking VOVE for the latest verification result…", "info");
  refreshComplianceStatus({ silent: true });
}

function stopPolling() {
  pollingActive = false;
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
}

// ---------- view 4: done ----------

$("logout").addEventListener("click", doLogout);
$("logout-done").addEventListener("click", doLogout);

async function doLogout() {
  stopPolling();
  complianceCaseId = null;
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch { /* session may already be gone */ }
  localStorage.removeItem(TOKEN_KEY);
  registeredCodes = {};
  pendingAccountId = null;
  selectTab("signin");
  show("view-auth");
}

// ---------- routing ----------

async function routeBySession() {
  if (!getToken()) {
    show("view-auth");
    return null;
  }
  try {
    const session = await api("/api/auth/session");
    if (session.account.status === "PENDING_VERIFICATION") {
      registeredCodes = {};
      renderVerifyView({ session });
      show("view-verify");
    } else if (session.complianceGate?.approved) {
      show("view-done");
    } else {
      renderComplianceView(session);
      show("view-compliance");
    }
    return session;
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      show("view-auth");
    } else {
      showMessage(error.message, "error");
    }
    return null;
  }
}

routeBySession();
