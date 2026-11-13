const TOKEN_KEY = "stablex_session";
const $ = (id) => document.getElementById(id);
const state = { account: null, customer: null, requirements: null, authenticated: false, enabled: false };

async function api(url, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY) || "";
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    location.href = "/auth.html";
    throw new Error("Your StableX session has expired. Sign in again.");
  }
  if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
  return data;
}
function show(id, text, kind = "") {
  const element = $(id);
  element.textContent = text;
  element.className = "paytrie-status" + (kind ? " " + kind : "");
}
function profile() {
  return {
    firstName: $("firstName").value.trim(),
    lastName: $("lastName").value.trim(),
    dateOfBirth: $("dateOfBirth").value,
    phone: $("phone").value.trim(),
    addressLine1: $("addressLine1").value.trim(),
    addressLine2: $("addressLine2").value.trim(),
    city: $("city").value.trim(),
    province: $("province").value,
    postalCode: $("postalCode").value.trim(),
    occupation: $("occupation").value.trim(),
    notPepConfirmed: $("notPepConfirmed").checked,
    notThirdPartyConfirmed: $("notThirdPartyConfirmed").checked,
  };
}
function labelFor(path) {
  return path.split(".").at(-1)
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (m) => m.toUpperCase());
}
function fieldType(path) {
  return path === "dob" ? "date" : "text";
}
function updateFundingAndExecution() {
  const verified = String(state.customer?.providerStatus || "").toLowerCase() === "verified";
  const approved = Boolean(state.readiness?.platformExecutionApproved);
  if (verified && approved) {
    $("finalStatus").textContent = "Paytrie KYC is verified and StableX platform execution is approved. You can proceed to a supported Paytrie transfer in StableX.";
    $("finalStatus").className = "paytrie-status good";
  } else if (verified) {
    $("finalStatus").textContent = "Paytrie KYC is verified. StableX live Paytrie transactions are still disabled pending Paytrie's explicit approval of our platform integration.";
    $("finalStatus").className = "paytrie-note";
  } else {
    $("finalStatus").textContent = "Paytrie verification is not complete yet. Follow the outstanding steps and refresh the status after Paytrie reviews your identity.";
    $("finalStatus").className = "paytrie-note";
  }
}
function renderRequirements(data) {
  state.requirements = data || null;
  const requirements = data?.requirements || {};
  const required = [...new Set(Object.values(requirements).flatMap((item) =>
    Array.isArray(item?.requiredFields) ? item.requiredFields : []
  ))];
  const summary = Object.entries(requirements).map(([name, item]) =>
    `${name}: ${item?.status || "unknown"}${item?.requiredFields?.length ? " (" + item.requiredFields.join(", ") + ")" : ""}`
  );
  show("requirementsStatus", summary.length ? summary.join("\n") : "Paytrie has not returned any outstanding profile requirements.");

  const form = $("requirementsForm");
  const container = $("requirementsFields");
  container.replaceChildren();
  if (required.length) {
    for (const path of required) {
      const wrapper = document.createElement("div");
      wrapper.className = "paytrie-field";
      const label = document.createElement("label");
      label.textContent = labelFor(path);
      label.htmlFor = "required-" + path.replace(/[^a-zA-Z0-9]/g, "-");
      const input = document.createElement("input");
      input.id = label.htmlFor;
      input.name = path;
      input.type = fieldType(path);
      input.autocomplete = "off";
      input.required = true;
      label.title = path;
      input.setAttribute("aria-label", path);
      wrapper.append(label, input);
      const hint = document.createElement("small");
      hint.className = "muted";
      hint.textContent = path;
      wrapper.append(hint);
      container.append(wrapper);
    }
    form.classList.remove("paytrie-hidden");
  } else {
    form.classList.add("paytrie-hidden");
  }

  const phonePending = requirements.phoneVerification?.status === "pending";
  $("phoneVerification").classList.toggle("paytrie-hidden", !phonePending);
  const blocking = Object.entries(requirements).some(([name, item]) =>
    name !== "kyc" && (item?.status === "pending" || item?.status === "processing")
  );
  const kycPending = requirements.kyc?.status === "pending";
  $("getKycLink").disabled = !state.authenticated || blocking || !kycPending;
  $("refreshStatus").disabled = !state.authenticated;
}
async function refreshState() {
  const data = await api("/api/paytrie/customer/onboarding");
  state.customer = data.customer;
  state.authenticated = Boolean(data.authenticated);
  state.readiness = data.readiness || {};
  state.enabled = Boolean(state.readiness.enabled);
  const customer = data.customer;
  if (customer) {
    show("registrationMessage",
      `Paytrie account linked: ${customer.email}. Provider status: ${customer.providerStatus || "not yet checked"}. Onboarding: ${customer.onboardingStatus}.`,
      "good"
    );
  }
  $("verifyPaytrieCode").disabled = !customer;
  $("resendPaytrieCode").disabled = !customer;
  if (state.authenticated) {
    $("authMessage").textContent = "Paytrie session is active for this StableX customer. Session expires at " + data.sessionExpiresAt;
    $("refreshStatus").disabled = false;
    const req = await api("/api/paytrie/customer/onboarding/requirements");
    renderRequirements(req);
  } else {
    $("authMessage").textContent = customer
      ? "Paytrie identity is linked. Verify the email code to continue."
      : "Connect or register your Paytrie account first.";
    $("requirementsForm").classList.add("paytrie-hidden");
    $("phoneVerification").classList.add("paytrie-hidden");
    $("getKycLink").disabled = true;
    $("refreshStatus").disabled = true;
  }
  updateFundingAndExecution();
}
async function boot() {
  if (!localStorage.getItem(TOKEN_KEY)) {
    location.href = "/auth.html";
    return;
  }
  try {
    const session = await api("/api/auth/session");
    state.account = session.account;
    const account = state.account || {};
    $("customerEmail").value = account.email || "";
    show("accountStatus",
      `${account.fullName || "StableX customer"} · ${account.email || ""} · ${account.accountType || ""} · ${account.country || ""} · ${account.status || ""}`,
      account.accountType === "PERSONAL" && account.country === "CA" && account.status === "ACTIVE" ? "good" : "bad"
    );
    const data = await api("/api/paytrie/customer/onboarding");
    state.readiness = data.readiness || {};
    state.enabled = Boolean(state.readiness.enabled);
    const r = state.readiness;
    const flags = [
      "Onboarding API: " + (r.enabled ? "enabled" : "not enabled"),
      "Paytrie API key: " + (r.apiKeyPresent ? "configured" : "missing"),
      "Account eligibility: " + (r.eligibleStableXAccount ? "eligible" : "not eligible"),
      "Platform execution: " + (r.platformExecutionApproved ? "approved" : "disabled"),
    ];
    show("readinessStatus", flags.join("\n") + "\n" + r.note,
      r.enabled && r.apiKeyPresent && r.eligibleStableXAccount ? "good" : "bad"
    );
    $("connectPaytrie").disabled = !(r.enabled && r.apiKeyPresent && r.eligibleStableXAccount);
    await refreshState();
  } catch (error) {
    show("readinessStatus", error.message, "bad");
    $("connectPaytrie").disabled = true;
    if (state.account) {
      show("accountStatus",
        `${state.account.fullName || "StableX customer"} · ${state.account.email || ""} · ${state.account.accountType || ""} · ${state.account.country || ""}`,
        "bad"
      );
    }
  }
}
$("connectPaytrie").addEventListener("click", async () => {
  $("connectPaytrie").disabled = true;
  try {
    const result = await api("/api/paytrie/customer/onboarding/register", {
      method: "POST",
      body: profile(),
    });
    state.customer = result.customer;
    $("verifyPaytrieCode").disabled = false;
    $("resendPaytrieCode").disabled = false;
    show("registrationMessage", result.message, "good");
    show("authMessage", "A Paytrie email code has been requested. Check your inbox.", "good");
    $("paytrieCode").focus();
  } catch (error) {
    show("registrationMessage", error.message, "bad");
  } finally {
    $("connectPaytrie").disabled = false;
  }
});
$("verifyPaytrieCode").addEventListener("click", async () => {
  $("verifyPaytrieCode").disabled = true;
  try {
    const result = await api("/api/paytrie/customer/onboarding/verify", {
      method: "POST",
      body: { code: $("paytrieCode").value.trim() },
    });
    state.authenticated = true;
    show("authMessage", result.message, "good");
    renderRequirements(result.requirements);
    await refreshState();
  } catch (error) {
    show("authMessage", error.message, "bad");
  } finally {
    $("verifyPaytrieCode").disabled = false;
  }
});
$("resendPaytrieCode").addEventListener("click", async () => {
  try {
    const result = await api("/api/paytrie/customer/onboarding/login-code", { method: "POST", body: {} });
    show("authMessage", result.message, "good");
  } catch (error) { show("authMessage", error.message, "bad"); }
});
$("requirementsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = {};
  for (const input of $("requirementsFields").querySelectorAll("input[name]")) values[input.name] = input.value.trim();
  try {
    const result = await api("/api/paytrie/customer/onboarding/requirements", { method: "PATCH", body: { values } });
    show("requirementsStatus", result.message, "good");
    renderRequirements(result.requirements);
  } catch (error) { show("requirementsStatus", error.message, "bad"); }
});
$("sendPhoneCode").addEventListener("click", async () => {
  try {
    const result = await api("/api/paytrie/customer/onboarding/phone-code", {
      method: "POST", body: { phone: $("phoneForVerify").value.trim() },
    });
    $("phoneMessage").textContent = result.message;
  } catch (error) { $("phoneMessage").textContent = error.message; }
});
$("verifyPhoneCode").addEventListener("click", async () => {
  try {
    const result = await api("/api/paytrie/customer/onboarding/phone-verify", {
      method: "POST", body: { code: $("phoneCode").value.trim() },
    });
    $("phoneMessage").textContent = result.message;
    renderRequirements(result.requirements);
  } catch (error) { $("phoneMessage").textContent = error.message; }
});
$("getKycLink").addEventListener("click", async () => {
  $("getKycLink").disabled = true;
  try {
    const result = await api("/api/paytrie/customer/onboarding/kyc-link", { method: "POST", body: {} });
    $("kycLink").href = result.url;
    $("kycLink").classList.remove("paytrie-hidden");
    show("kycMessage", result.message + (result.expiresAt ? " Link expires: " + result.expiresAt : ""), "good");
  } catch (error) {
    show("kycMessage", error.message, "bad");
  } finally { $("getKycLink").disabled = false; }
});
$("refreshStatus").addEventListener("click", async () => {
  $("refreshStatus").disabled = true;
  try {
    const result = await api("/api/paytrie/customer/onboarding/refresh", { method: "POST", body: {} });
    state.customer = result.customer;
    renderRequirements(result.requirements);
    show("kycMessage", result.message, result.providerVerified ? "good" : "");
    updateFundingAndExecution();
  } catch (error) { show("kycMessage", error.message, "bad"); }
  finally { $("refreshStatus").disabled = false; }
});
boot();
