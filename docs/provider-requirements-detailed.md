# StableX — Detailed Provider Requirements

For each provider: **what to request, why we need it, what form it should arrive
in, and the follow-up questions to resolve before integration.** Credentials go
into the server-side `.env` only. Request sandbox credentials first.

---

## 1. Vove ID — KYC / KYB (`https://docs.voveid.com/docs`)

**Role:** verifies customers (individuals = KYC) and businesses (KYB) before any
transfer can move. This is the compliance gate in the StableX architecture.

**Account prerequisites:**
- StableX entity registered/approved as a Vove merchant/developer account.
- Confirm KYB and KYC products are both enabled for the account.

**Request from Vove (sandbox first):**
1. **Sandbox API key (server-side secret)** — used by the backend to create cases.
2. **Public key / SDK token** — used to construct the hosted verification session URL the customer opens in a browser.
3. **KYB flow IDs** for the sandbox jurisdictions we plan to test (e.g. Nigeria, Kenya, Ghana) — one flow per business type/country if Vove separates them.
4. **KYC flow access** — confirmation that the individual-verification SDK/hosted flow is available to our account, plus its flow ID and any SDK initialization parameters (framework support: plain web, React, etc.).
5. **Webhook configuration** — after we supply our endpoint URL (`/api/kyb/webhook`, secured over HTTPS/tunnel), Vove must issue the webhook signing secret. Ask for the exact signature header format and a sample signed payload for testing.
6. **API docs version confirmation** — we target `https://api.voveid.net/v2`. Confirm this remains current for sandbox.
7. **Data requirements list** — which subject fields each flow returns (names, date of birth, business registration, risk flags) and what statuses exist (e.g. `APPROVED`, `PENDING`, `REJECTED` values).

**Deliverables to StableX:** keys + flow IDs + webhook secret + signed sample webhook + status/list documentation.

**Questions to resolve:**
- Rate limits on sandbox.
- How long a case record remains retrievable.
- Whether Vove performs AML/sanctions screening as part of KYC/KYB, or whether we must source screening separately (this decides if we need a dedicated AML provider next to Vove).

---

## 2. Paytrie — CAD ↔ USDC/CADC (`https://paytrie.com/`)

**Role:** Canadian on/off-ramp. Two potential roles must be clarified: quote
source vs execution venue.

**Account prerequisites:**
- StableX onboarding/approval as a partner or business customer.
- Confirm Beta availability for API users.

**Request from Paytrie:**
1. **API key** for the v2 API (`https://api.paytrie.com/v2`). Confirm which header they use (`x-api-key` per our current prototype).
2. **Quote endpoint scope** — confirm `GET /quotes` is enabled for our key and its rate limits.
3. **Transaction API integration model** — the documented transaction flow requires an authenticated **user JWT** + customer payment handling. Request:
   - Whether a server-to-server (B2B) transaction model exists that does not require end-user accounts.
   - If user JWT is required: the user registration/JWT issuance flow, and whether it can be operated by StableX on behalf of customers.
   - The transaction creation endpoint contract (request fields, idempotency support).
4. **Customer payment handling** — what payment rails customers use (Interac, wire, etc.) and where funds land.
5. **Webhooks** — transaction status webhook URL + signing secret + event list.
6. **Supported assets confirmation** — USDC-BASE, CADC-BASE addresses/functions they accept, min/max per transaction.

**Deliverables to StableX:** API key, integration docs, webhook secret, decision on B2B vs user-JWT model.

**Questions to resolve:**
- Per-transaction minimums/maximums and daily limits.
- Settlement timing (when funds/USDC arrive after transaction approval).

---

## 3. Honeycoin — African fiat collection & payouts (`https://honeycoin.app/`)

**Role:** B2B fiat rails — collections (customer pays NGN/KES/etc. into us) and
payouts (recipient gets local currency). This is the primary execution target
for milestone M3.

**Account prerequisites:**
- StableX business account approved for the **B2B** product.
- Products must be **enabled for our account per corridor** (authorization matters, not just the key).

**Request from Honeycoin (sandbox first):**
1. **Sandbox API key** (server-side).
2. **Public key** — used together with the API key to generate bearer tokens.
3. **Corridor/product enablement list** — which of the following are enabled for our sandbox account: NGN, KES, UGX, TZS, ZAR, XAF, XOF, GHS collections and payouts. If some are not enabled, ask what the enablement process is.
4. **FX rate endpoint confirmation** — we target `GET /api/sandbox/b2b/utilities/rates`. Confirm this plus whether the same key allows production when ready.
5. **Order/payout creation endpoint documentation** — full request/response schema, including:
   - Idempotency mechanism (header or body field) — required by our architecture.
   - Destination formats for payouts (bank account, mobile money, wallet).
   - Fee breakdowns returned by their API.
6. **Webhook scheme** — webhook URL registration, signing/hashing scheme with a sample, and the complete event catalog (e.g. payout pending/succeeded/failed).
7. **Compliance requirements** — whether sender KYB approval is required before live order creation, and what documents they need from StableX.
8. **Sandbox test data** — test bank accounts/mobile numbers and test currency pairs supported in sandbox.

**Deliverables to StableX:** sandbox API key + public key, enabled corridor list, order API docs, webhook secret + sample, compliance checklist.

**Questions to resolve:**
- Bearer token expiry behavior (we cache ~50 minutes today).
- Whether collections can be tied to a specific transfer via reference/narration fields (for reconciliation).
- Settlement windows and payout cut-off times per corridor.

---

## 4. Paycrest — stablecoin ↔ African fiat (`https://www.paycrest.io/`)

**Role:** stablecoin↔fiat liquidity via on-chain institutions. Public rate
preview already works without credentials; **order creation** is what's missing.

**Account prerequisites:**
- **Sender KYB approval** with Paycrest (their documented prerequisite for order access).

**Request from Paycrest:**
1. **Order API access** — approval of StableX as an institutional sender, which unlocks the order endpoints.
2. **API key + API secret** for authenticated endpoints.
3. **Per-token/network configuration** — for each token/network we will send (USDC-BASE first), StableX must be registered/configured with:
   - Sender fee (bps or amount),
   - Fee address,
   - Refund address.
4. **Order endpoint docs** — request/response schema, idempotency, order status states, and how the inst-payer/recipient details are passed.
5. **Webhook or polling** — how we learn an order is fulfilled (webhook URL registration + signing scheme, or documented polling endpoint).
6. **Corridor confirmation** — the public rate endpoint supports NGN, KES, UGX, TZS, MWK, BRL. Request written confirmation whether **XAF, XOF, ZAR, GHS, GBP** are supported through order APIs under approved accounts (our public-endpoint tests on 2026-11-04 returned 400 for these).

**Deliverables to StableX:** sender approval, key + secret, configured fee/fee-address/refund-address settings, order docs, webhook scheme, corridor confirmation.

**Questions to resolve:**
- Order settlement timing (USDC escrow to local delivery).
- Minimum/maximum order sizes and any per-day caps.

---

## 5. Apaylo — CAD rails (`https://apaylo.com/`)

**Role:** Canadian fiat collection/payout partner (candidate complement or
alternative to Paytrie).

**Request from Apaylo:**
1. Partner/business account creation for StableX.
2. **API documentation** (hosted doc URL) and a full endpoint list: collections (Interac/EFT/wire) and payouts.
3. **API key + any environment identifier** (their pattern may use merchant ID + secret — request whatever their model needs).
4. **Sandbox environment** with test accounts, plus cut-off times per rail.
5. **Webhook/event scheme** for payment status changes.

**Questions to resolve:**
- Which CAD rails they support in/out (Interac e-Transfer, EFT, wire, FedNow).
- KYB prerequisites for the StableX business account.
- Whether they support CAD↔USDC conversion themselves or only CAD movement.

---

## 6. Tetra Trust — CADD (`https://tetradg.com/cadd`)

**Role:** CADD stablecoin issuer/custodian (CAD digital asset).

**Request from Tetra:**
1. **CADD contract addresses** for each supported network (Base specifically; their FAQ lists Base/Ethereum/Solana support) — вводится into `config/assets.js` (not `.env`).
2. **Partnership/API access for mint & redeem** — whether APIs exist for business customers, account process, and credentials/API keys if so.
3. **Custody model** — does Tetra custody, or do we self-custody with their platform?
4. **Redemption process** — how CADD converts back to CAD payout (timing, fees).

**Deliverables:** verified contract addresses (required before CADD is usable anywhere in the system), API access if offered.

**Questions to resolve:**
- Whether CADD is integrated with Paytrie/Apaylo corridors for CAD conversion.

---

## 7. Nomba — NGN collections & payouts (`https://nomba.com/`)

**Role:** Nigerian fiat rails — collections via virtual accounts, payouts.

**Request from Nomba:**
1. Business account for StableX + **API sandbox keys**.
2. **API documentation** — collections (virtual account creation, static vs dynamic), payouts, balance queries.
3. **Idempotency support** on transfers.
4. **Webhook secret + full event list** (collections received, payout completed/failed).
5. Fee schedule per transaction type.

**Questions to resolve:**
- Whether external accounts like StableX can create collections via API in sandbox, or only via dashboard.
- KYB/licensing prerequisites.

---

## 8. Fincra — NGN + multi-country payout (`https://fincra.com/`)

**Role:** Nigerian collections/payouts plus broader African corridors (candidates: GHS, KES, UGX, XAF, XOF, ZAR).

**Request from Fincra:**
1. Business account + **sandbox API keys** (business ID / public key / secret key depending on their model).
2. **API documentation** — quotes, collections, payouts, supported countries list.
3. **Corridor confirmation** — which of GHS/KES/UGX/XAF/XOF/ZAR are available for payouts from the StableX account type.
4. **Webhook signing scheme + event catalog.**
5. Fee schedule + settlement.cut-offs.

**Questions to resolve:**
- Overlap vs Honeycoin — which is better per corridor; can both be enabled for redundancy.

---

## 9. Strails — CNGN (`https://strails.co` — verify)

**Role:** CNGN stablecoin (naira-pegged) issuer/liquidity.

**Request from Strails:**
1. **CNGN contract addresses** (Base?) and issuer configuration — goes to `config/assets.js`.
2. **API access for mint/redeem or transfer liquidity** — docs + sandbox keys if the platform supports it.
3. **Peg mechanics** — redemption path CNGN→NGN and timing.
4. Confirm the **official documentation URL** (currently unclear).

---

## 10. Bridge (Stripe) — USD/GBP/EUR (`https://bridge.xyz/`)

**Role:** USD/EUR (+ GBP) on/off-ramp and stablecoin issuance — candidate rail
for USD↔USDC and EUR↔EURC conversions.

**Request from Bridge:**
1. **Integration onboarding** — stablecoin issuance/on-ramp/off-ramp product terms for the StableX entity (they require KYB + compliance review).
2. **API access credentials + docs** (dashboard URL, environment, keys).
3. **KYC model decision** — whether end-customer verification flows through Bridge's KYC stack or StableX runs its own (Vove) and attests. This shapes the whole compliance architecture.
4. **Supported rails** — USD bank transfers, EUR SEPA, GBP faster payments; timing and limits.

**Questions to resolve:**
- Division of responsibility vs Circle for USD↔USDC (avoid integrating both for the same job).
- Jurisdiction support (Canada, Nigeria, Kenya use cases).

---

## 11. Circle — USDC (`https://www.circle.com/`)

**Role:** USDC issuer — mint/redemption and/or wallet infrastructure.

**Request from Circle:**
1. **Circle Mint / Circle Wallet enrollment** for the StableX entity (needs business verification).
2. **API credentials + docs** if we use their wallets/minting APIs.
3. Confirmation that **Base USDC** (`0x833…2913`) is the correct mainnet registration path.
4. Redemption process: USDC→USD bank payout timing and fees.

**Questions to resolve:**
- Do we need Circle at all if Bridge handles issuance? (Pick per architecture decision; may only need one.)

---

## 12. CoinGecko — reference pricing (`https://www.coingecko.com/`)

**Role to confirm:** price-data aggregator, not liquidity. Clarify with contact
whether this was listed as a pricing source.

**Request if confirmed as pricing source:**
1. **API key** (demo or Pro tier depending on call volume).
2. Confirm the reference-pair IDs we should read for CAD/NGN/etc. vs USD anchors.

---

## Cross-cutting items from the contact (not provider-specific)

1. **ZAND** — what is this? (Given alongside ZAR; needs definition before anything.)
2. **"Coingekko"** — liquidity or pricing? (See #12.)
3. **Solana** — is it in scope for stablecoin settlement, or Base-only for the pilot? Codebase is Base-only today.
4. **First live corridor** — recommend CAD↔NGN (Paytrie/Apaylo + Nomba/Fincra) or USDC↔African fiat (Honeycoin/Paycrest). Confirm which to prioritize.
5. For every provider: rate limits, idempotency standards, webhook signature schemes, and sandbox test data.
6. Confirm each provider's **KYB/product approval prerequisites** for the StableX entity — some (Paycrest, Bridge, Circle) require business approval before API access works.

---

## Handover rules for whoever receives credentials

- Values land in the server-side `.env` only; never in source, chat, or browser code.
- Sandbox credentials first; production only after sandbox integration passes.
- We verify arrived configuration via readiness endpoints and report gaps.
