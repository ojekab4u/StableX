const $ = (id) => document.getElementById(id);
const state = { customerId: "customer-001", assets: [], quotes: [], beneficiaries: [] };
const money = (n, currency) => `${new Intl.NumberFormat("en-US",{maximumFractionDigits:6}).format(Number(n)||0)} ${currency||""}`;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function api(url, options={}) {
  const response = await fetch(url, { ...options, headers: { ...(options.headers||{}), ...(options.body ? {"Content-Type":"application/json"} : {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
  return data;
}
function customerId(){ return $("customer-id").value.trim(); }
function message(id, text, error=false){ const node=$(id); node.textContent=text; node.classList.toggle("error",error); }
async function loadCustomer(){
  state.customerId=customerId();
  if(!state.customerId) return message("customer-message","Enter a StableX customer ID.",true);
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
    await Promise.all([loadBeneficiaries(),loadTransfers()]);
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
  if(!rows.length){body.innerHTML='<tr><td colspan="5" class="muted">No durable transfers for this customer yet.</td></tr>';return;}
  rows.forEach(t=>{
    const tr=document.createElement("tr");
    const values=[t.id||t.transferId||"—",`${t.sourceCurrency||t.from||"?"} → ${t.destinationCurrency||t.to||"?"}`,money(t.sourceAmount??t.amount,t.sourceCurrency||t.from),t.status||"—",t.createdAt?new Date(t.createdAt).toLocaleString():"—"];
    values.forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.append(td);});body.append(tr);
  });
}
$("load-customer").addEventListener("click",loadCustomer);
$("refresh-customer").addEventListener("click",loadCustomer);
$("refresh-transfers").addEventListener("click",()=>loadTransfers().catch(e=>message("customer-message",e.message,true)));
$("create-beneficiary").addEventListener("click",createBeneficiary);
$("get-quotes").addEventListener("click",getQuotes);
$("quotes").addEventListener("click",e=>{const btn=e.target.closest("[data-quote]");if(btn&&!btn.disabled)selectQuote(btn.dataset.quote);});
$("to").addEventListener("change",()=>{$("beneficiary-currency").value=$("to").value;});
(async()=>{try{await loadAssets();await loadCustomer();}catch(e){message("customer-message",e.message,true);}})();
