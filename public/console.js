const $ = (id) => document.getElementById(id);
const state = { customerId: null, assets: [], quotes: [], beneficiaries: [] };
const TOKEN_KEY = "stablex_session";
const money = (n, currency) => `${new Intl.NumberFormat("en-US",{maximumFractionDigits:6}).format(Number(n)||0)} ${currency||""}`;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function api(url, options={}) {
  const token = localStorage.getItem(TOKEN_KEY) || "";
  const response = await fetch(url, { ...options, headers: { ...(options.headers||{}), ...(token ? {"Authorization": `Bearer ${token}`} : {}), ...(options.body ? {"Content-Type":"application/json"} : {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { localStorage.removeItem(TOKEN_KEY); location.href = "/auth.html"; throw new Error("Session expired. Sign in again."); }
  if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
  return data;
}
function customerId(){ return state.customerId; }
function message(id, text, error=false){ const node=$(id); node.textContent=text; node.classList.toggle("error",error); }
// Identity comes from the StableX sign-in session; there is no manual
// customer entry on this page.
async function boot(){
  if(!localStorage.getItem(TOKEN_KEY)){ location.href = "/auth.html"; return; }
  try{
    const session = await api("/api/auth/session");
    const account = session.account || {};
    state.customerId = account.accountId;
    const badge = $("session-badge");
    badge.textContent = "Signed in: " + (account.email || account.accountId) +
      " · Compliance: " + (session.complianceGate?.status || "—");
    if(session.complianceGate?.approved) badge.classList.add("good");
    await refreshCustomerStatus();
  }catch(e){ message("customer-message", e.message, true); }
}
async function refreshCustomerStatus(){
  if(!state.customerId) return;
  $("gate-status").textContent="Loading…";
  try{
    const [gate, bridge]=await Promise.all([
      api(`/api/compliance/status?customerId=${encodeURIComponent(state.customerId)}`),
      api("/api/bridge/readiness").catch(e=>({status:"Unavailable",note:e.message}))
    ]);
    $("gate-status").textContent=gate.gate?.status || "Unknown";
    $("gate-status").className=gate.gate?.approved?"good":"";
    $("case-count").textContent=gate.caseCount ?? "—";
    $("bridge-status").textContent=bridge.capabilities?.join(", ") || bridge.status || (bridge.configured?"Configured":"Readiness loaded");
    message("customer-message",gate.gate?.approved?"Compliance approved. Quote selection is enabled for this customer.":`Compliance gate: ${gate.gate?.status||"Unknown"}. Quote selection will be blocked until approved.`);
    await Promise.all([loadBeneficiaries(),loadTransfers(),refreshBridgeOnboarding()]);
  }catch(e){message("customer-message",e.message,true);$("gate-status").textContent="Unavailable";}
}
async function loadAssets(){
  const data=await api("/api/assets"); state.assets=data.assets||[];
  const from=$("from"),to=$("to"),beneficiaryCurrency=$("beneficiary-currency");
  const codes=state.assets.map(a=>a.code).filter(Boolean);
  from.innerHTML=codes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  to.innerHTML=codes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  from.value=codes.includes("CAD")?"CAD":codes[0];
  to.value=codes.includes("USDC")?"USDC":codes[1];
  beneficiaryCurrency.innerHTML=codes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  beneficiaryCurrency.value=to.value;
}
async function loadBeneficiaries(){
  const data=await api(`/api/transfers/beneficiaries?customerId=${encodeURIComponent(state.customerId)}`);
  state.beneficiaries=data.beneficiaries||[];
  $("beneficiary-select").innerHTML=state.beneficiaries.length
    ? state.beneficiaries.map(b=>`<option value="${esc(b.beneficiaryId)}">${esc(b.details?.name||"Recipient")} · ${esc(b.details?.currency||"")} · ${esc(b.beneficiaryId.slice(0,8))}</option>`).join("")
    : '<option value="">No saved beneficiaries — add one below</option>';
}
async function createBeneficiary(){
  const details={name:$("beneficiary-name").value.trim(),country:$("beneficiary-country").value.trim().toUpperCase(),currency:$("beneficiary-currency").value};
  const wallet=$("beneficiary-wallet").value.trim(), account=$("beneficiary-account").value.trim(), bank=$("beneficiary-bank").value.trim(), network=$("beneficiary-network").value.trim();
  if(wallet){details.walletAddress=wallet;if(network)details.network=network;}
  if(account)details.accountNumber=account;if(bank)details.bankName=bank;
  try{
    const data=await api("/api/transfers/beneficiaries",{method:"POST",body:JSON.stringify({customerId:state.customerId,details})});
    await loadBeneficiaries();$("beneficiary-select").value=data.beneficiary.beneficiaryId;
    message("beneficiary-message",`Beneficiary saved: ${data.beneficiary.beneficiaryId}`);
  }catch(e){message("beneficiary-message",e.message,true);}
}
async function getQuotes(){
  const amount=Number($("amount").value),from=$("from").value,to=$("to").value;
  if(!amount||amount<=0||amount>1000000||from===to)return message("quote-message","Enter a valid amount and choose two different currencies.",true);
  $("get-quotes").disabled=true;message("quote-message","Requesting provider quotes…");
  try{
    const data=await api("/api/routing/quotes",{method:"POST",body:JSON.stringify({from,to,amount})});
    state.quotes=data.candidates||[];
    renderQuotes(data);
    message("quote-message",`${data.quoteType} · ${state.quotes.length} candidate quote(s). ${data.executionEnabled?"At least one candidate reports execution enabled.":"No candidate is currently executable."}`);
  }catch(e){$("quotes").textContent=e.message;message("quote-message",e.message,true);}
  finally{$("get-quotes").disabled=false;}
}
function renderQuotes(data){
  const host=$("quotes");host.replaceChildren();
  if(!state.quotes.length){host.innerHTML='<p class="muted">No provider returned a quote for this corridor. Check unavailable-provider details below.</p>'; }
  state.quotes.forEach((q,i)=>{
    const card=document.createElement("article");card.className="quote-card";
    const kind=q.providerClass||q.quoteType||"UNCLASSIFIED";
    const output=q.destinationAmount==null?"—":money(q.destinationAmount,q.to);
    const fields=[
      ["Quote class",kind],["Rate",q.rate??"—"],["Fee",q.fee==null?"Not supplied":money(q.fee,q.feeCurrency)],["Expires",q.expiresAt?new Date(q.expiresAt).toLocaleString():"Not supplied"],["Execution",q.executionEnabled?"Enabled by adapter":"Not enabled"]
    ];
    card.innerHTML=`<div class="quote-top"><span class="eyebrow">#${i+1} · ${esc(kind)}</span><span class="pill">${q.executionEnabled?"EXECUTABLE":"PREVIEW ONLY"}</span></div><h3>${esc(q.provider)}</h3><strong class="output">${esc(output)}</strong><div class="quote-meta">${fields.map(([k,v])=>`<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div><button type="button" class="choose" data-quote="${esc(q.quoteId)}" ${!q.quoteId||!$("beneficiary-select").value?"disabled":""}>Create draft &amp; select quote</button>`;
    host.append(card);
  });
  if(data.unavailableProviders?.length){
    const details=document.createElement("details");details.className="unavailable";details.innerHTML=`<summary>Providers without a quote (${data.unavailableProviders.length})</summary><ul>${data.unavailableProviders.map(p=>`<li><b>${esc(p.provider)}</b>: ${esc(p.reason||"No quote returned")}</li>`).join("")}</ul>`;host.append(details);
  }
  if(!state.beneficiaries.length){const note=document.createElement("p");note.className="notice";note.textContent="Save a beneficiary before selecting a quote.";host.append(note);}
}
async function selectQuote(quoteId){
  const beneficiaryId=$("beneficiary-select").value;
  if(!beneficiaryId)return message("quote-message","Save or select a beneficiary first.",true);
  const quote=state.quotes.find(q=>q.quoteId===quoteId);
  if(!quote)return message("quote-message","Quote is no longer in this view. Request fresh quotes.",true);
  try{
    message("quote-message","Creating durable DRAFT transfer…");
    const draft=await api("/api/transfers",{method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({customerId:state.customerId,beneficiaryId,from:quote.from,to:quote.to,amount:quote.sourceAmount})});
    const transfer=draft.transfer||draft;
    const transferId=transfer.id||transfer.transferId;
    if(!transferId)throw new Error("Transfer was created but the API response did not include its transfer ID. Refresh transfer history before retrying.");
    message("quote-message",`Draft ${transferId} created. Locking selected quote…`);
    const selection=await api("/api/routing/select",{method:"POST",body:JSON.stringify({customerId:state.customerId,transferId,quoteId})});
    message("quote-message",`Quote selected and persisted. Transfer ${transferId} is now ${selection.transfer?.status||selection.status||"QUOTED"}. No provider order or funds movement occurred.`);
    await loadTransfers();
  }catch(e){message("quote-message",e.message,true);await loadTransfers().catch(()=>{});}
}
async function loadTransfers(){
  const data=await api(`/api/transfers?customerId=${encodeURIComponent(state.customerId)}`);
  const rows=data.transfers||[],body=$("transfers");body.replaceChildren();
  if(!rows.length){body.innerHTML='<tr><td colspan="6" class="muted">No durable transfers for this customer yet.</td></tr>';return;}
  rows.forEach(t=>{
    const tr=document.createElement("tr");
    const id=t.id||t.transferId||"—";
    const values=[id,`${t.sourceCurrency||t.from||"?"} → ${t.destinationCurrency||t.to||"?"}`,money(t.sourceAmount??t.amount,t.sourceCurrency||t.from),t.status||"—",t.createdAt?new Date(t.createdAt).toLocaleString():"—"];
    values.forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.append(td);});
    const actions=document.createElement("td");
    if(t.status==="QUOTED" && t.sourceCurrency==="NGN" && t.destinationCurrency==="USDC" && t.quote?.provider==="Honeycoin"){
      const create=document.createElement("button");create.type="button";create.textContent="Create Honeycoin order";create.addEventListener("click",()=>createHoneycoinOrder(id));actions.append(create);
    }
    const refresh=document.createElement("button");refresh.type="button";refresh.className="secondary";refresh.textContent="Refresh provider";refresh.addEventListener("click",()=>refreshProviderOrder(id));actions.append(refresh);
    tr.append(actions);body.append(tr);
  });
}
async function showProviderOrderResult(result){
  const host=$("provider-order-result");host.replaceChildren();
  const order=result.order||{};
  const rows=[
    ["Provider order",order.orderId||"—"],
    ["Provider transaction",order.providerTransactionId||"—"],
    ["Order status",order.status||"—"],
    ["Provider status",order.providerStatus||"—"],
    ["Payment method",order.paymentMethod||"—"],
    ["Settlement verified",result.settlementVerified===true?"Yes": "Not yet"],
    ["Transaction hash",order.transactionHash||"Not supplied by provider"],
  ];
  rows.forEach(([label,value])=>{const line=document.createElement("p");line.textContent=`${label}: ${value}`;host.append(line);});
  if(order.redirectUrl){const link=document.createElement("a");link.href=order.redirectUrl;link.target="_blank";link.rel="noopener noreferrer";link.textContent="Continue to Honeycoin payment";host.append(link);}
  if(order.paymentDetails){const line=document.createElement("p");line.textContent=`Payment details: ${JSON.stringify(order.paymentDetails)}`;host.append(line);}
  const note=document.createElement("p");note.className="muted";note.textContent=result.settlementVerified?"Base USDC settlement was verified.": "Do not treat provider payment success as completed until Base settlement is independently verified.";host.append(note);
}
async function createHoneycoinOrder(transferId){
  try{
    $("provider-order-message").textContent="Creating Honeycoin payment order…";
    const result=await api(`/api/transfers/${encodeURIComponent(transferId)}/provider-order`,{
      method:"POST",
      body:JSON.stringify({customerId:state.customerId,paymentMethod:$("honeycoin-method").value,email:$("honeycoin-email").value.trim()}),
    });
    await showProviderOrderResult(result);
    $("provider-order-message").textContent=result.message||"Honeycoin order response received.";
    await loadTransfers();
  }catch(e){$("provider-order-message").textContent=e.message;}
}
async function refreshProviderOrder(transferId){
  try{
    $("provider-order-message").textContent="Refreshing provider status and checking Base settlement…";
    const result=await api(`/api/transfers/${encodeURIComponent(transferId)}/provider-order/refresh`,{
      method:"POST",body:JSON.stringify({customerId:state.customerId}),
    });
    await showProviderOrderResult(result);
    $("provider-order-message").textContent=result.message||"Provider status refreshed.";
    await loadTransfers();
  }catch(e){$("provider-order-message").textContent=e.message;}
}
$("load-customer").addEventListener("click",refreshCustomerStatus);
$("refresh-customer").addEventListener("click",refreshCustomerStatus);
$("refresh-transfers").addEventListener("click",()=>loadTransfers().catch(e=>message("customer-message",e.message,true)));
$("create-beneficiary").addEventListener("click",createBeneficiary);
$("get-quotes").addEventListener("click",getQuotes);
$("quotes").addEventListener("click",e=>{const btn=e.target.closest("[data-quote]");if(btn&&!btn.disabled)selectQuote(btn.dataset.quote);});
$("to").addEventListener("change",()=>{$("beneficiary-currency").value=$("to").value;});
(async()=>{try{await loadAssets();await boot();}catch(e){message("customer-message",e.message,true);}})();


// Bridge onboarding status — session-based. The customer is always the
// signed-in account; this page no longer accepts an operator token.
const bridgeMessage = (text, error=false) => {
  const node = $("bridge-onboarding-status");
  node.textContent = text;
  node.classList.toggle("error", error);
};
async function refreshBridgeOnboarding() {
  if (!state.customerId) return;
  bridgeMessage("Loading saved Bridge onboarding and endorsement status…");
  try {
    const data = await api("/api/bridge/self/onboarding");
    const onboarding = data.onboarding || null;
    const providerId = onboarding?.providerCustomerId;
    const endorsements = onboarding?.endorsements || [];
    const endorsementSummary = endorsements.map(x => `${String(x.name || "").toUpperCase()}: ${String(x.status || "unknown").toUpperCase()}`).join(", ");
    const statusLine = [
      `StableX customer: ${String(state.customerId).slice(0,8)}…`,
      `Bridge customer: ${providerId ? String(providerId).slice(0,12)+"…" : "Not created"}`,
      `ToS accepted: ${onboarding?.signedAgreementId ? "Yes" : "No"}`,
      `Bridge onboarding: ${onboarding?.onboardingStatus || "Not started"}`,
      `Bridge customer status: ${String(onboarding?.bridgeStatus || "Not synchronized").toUpperCase()}`,
      `Endorsements: ${endorsementSummary || "Not synchronized yet"}`,
      `Last sync: ${onboarding?.statusCheckedAt ? new Date(onboarding.statusCheckedAt).toLocaleString() : "Never"}`,
      `Next step: ${data.nextStep || "—"}`,
    ].join(" · ");
    bridgeMessage(statusLine);
  } catch (e) {
    bridgeMessage(e.message, true);
  }
}
async function syncBridgeStatus() {
  try {
    const button = $("bridge-refresh");
    button.disabled = true;
    bridgeMessage("Retrieving the latest Bridge customer and endorsement statuses…");
    const result = await api("/api/bridge/self/status/refresh", { method: "POST", body: "{}" });
    await refreshBridgeOnboarding();
    const gate = result.transactionGate || {};
    bridgeMessage(`Bridge status synchronized. Base endorsement: ${gate.base ? "APPROVED" : "NOT APPROVED"} · SEPA endorsement: ${gate.sepa ? "APPROVED" : "NOT APPROVED"}. StableX VOVE compliance remains separate.`);
  } catch (e) {
    bridgeMessage(e.message, true);
  } finally {
    $("bridge-refresh").disabled = false;
  }
}
$("bridge-refresh").addEventListener("click", syncBridgeStatus);
