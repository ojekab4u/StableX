# StableX — Credential & Access Request List

Purpose: exactly what to obtain from each provider (or the account owner), what
configuration variable it lands in, and what it unlocks in the codebase. Share
this with the contact as-is after the clarifying questions at the bottom are
answered. **Never ask for or exchange secrets in chat — values go into the
server-side `.env` file only.**

Readiness of every integration can be checked live at any time via:

| Endpoint | Checks |
|---|---|
| `/api/compliance/readiness` | Vove KYB/KYC wiring |
| `/api/orchestration/overview` | All providers + stages |
| `/api/providers/readiness` | Honeycoin & Paycrest credentials |
| `/api/send/readiness` | Legacy send-workflow placeholders |

## Public vs credential-required summary (verified live 2026-11-04)

| Provider | Public without key? | Credentials needed for | What works today |
|---|---|---|---|
| Paytrie | ✅ Yes | Only transaction creation (optional key) | Live CAD↔USDC/CADC quotes |
| Paycrest | ✅ Yes | Order creation (KYB + API key/secret) | Live rate previews NGN/KES/UGX/TZS/MWK/BRL |
| CoinGecko | ✅ Yes | Pro key optional | Reference prices for USDC, USDT, EURC |
| Vove | ❌ No | API key, public key, flow ID, webhook secret | Nothing — simulator only |
| Honeycoin | ❌ No | API key + public key | Nothing — simulator only |
| Nomba | ❌ No | API key | Nothing — simulator only |
| Fincra | ❌ No | API key | Nothing — simulator only |
| Strails | ❌ No | API key + sandbox base URL | Nothing — simulator only |
| Tetra | ❌ No | API key + contract address | Nothing — simulator only |
| Apaylo | ❌ No | API key | Nothing — simulator only |
| Bridge | ❌ No | Sandbox API key | Nothing — simulator only |
| Circle | ❌ No | Sandbox API key | Nothing — simulator only |

**Bottom line:** You can already test live quotes from Paytrie and Paycrest right now without asking your contact for anything. All other providers require dashboard credentials.

---

## 1. Vove ID — KYC / KYB (compliance gate) — `https://docs.voveid.com/docs`

| Request | Details | Unlocks |
|---|---|---|
| Sandbox API key + public key | Server-side keys for the hosted KYB flow | `VOVE_ID_API_KEY`, `VOVE_ID_PUBLIC_KEY` → live KYB case creation (adapter already written) |
| KYB flow ID for each test jurisdiction | Flow selection per business type/country | `VOVE_ID_KYB_FLOW_ID` |
| Webhook signing secret | Configured in the Vove dashboard pointing at `/api/kyb/webhook` | `VOVE_ID_WEBHOOK_SECRET` → verified webhook receipt (webhook handler exists) |
| Individual **KYC** SDK/flow access | Confirm the individual-verification SDK and its sandbox credentials | Replaces the M1 compliance **simulator** for individuals |

## 2. Paycrest — stablecoin ↔ African fiat — `https://www.paycrest.io/`

| Request | Details | Unlocks |
|---|---|---|
| Sender KYB approval | Documented prerequisite for order access | Order creation (M3 payout leg) |
| API key + API secret | For authenticated order endpoints | `PAYCREST_API_KEY`, `PAYCREST_API_SECRET` → currently only the public rate preview is used (it already works live) |
| Sender fee, fee address, refund address per token/network | Dashboard configuration per documented onboarding | Correct fee math in order creation |
| **Corridor confirmation**: XAF, XOF, ZAR, GHS, GBP | Public rate endpoint tested 2026-11-04 returns 400 for these; ask whether order APIs support them under approved accounts, or which network | Extends `SUPPORTED_FIAT_PREVIEW` in `services/providers/paycrestService.js` |

## 3. Honeycoin — African fiat collection & payouts — `https://honeycoin.app/`

| Request | Details | Unlocks |
|---|---|---|
| Sandbox API key + public key | Enabled for the B2B product | `HONEYCOIN_API_KEY`, `HONEYCOIN_PUBLIC_KEY` → live FX rate previews (adapter already written; current values are placeholders) |
| Product/corridor enablement | Which corridors are enabled for the sandbox account: KES, UGX, TZS, ZAR, XAF, XOF, GHS, NGN | Confirms which legs live-quote |
| Order/payout API access scope | Whether the sandbox key can create payouts/orders, and the idempotency + webhook requirements | M3 payout execution |
| Webhook signature scheme | Exact header/signature format | M5 reconciliation |

## 4. Paytrie — CAD ↔ USDC/CADC — `https://paytrie.com/`

**Verified live 2026-11-04: the quoting endpoint (`/v2/quotes`) is public and
requires NO API key.** The `GET /quotes` corridor was called directly from the
StableX adapter and returned a live quote (`100 CAD -> 68.03 USDC-BASE`) with
no credentials attached. **Do not make API keys a request item for quotes.**

| Ask | Details | Unlocks |
|---|---|---|
| Transaction integration pattern (priority) | The documented transaction flow needs an authenticated user JWT + customer payment handling. Ask exactly: how does a platform account initialize transactions on behalf of customers, what KYC/KYB prerequisites Paytrie requires, and sandbox vs production differences | Whether Paytrie can be an *execution* leg (fiat↔stablecoin) or stays a free quote source |
| Optional: partner/API key | Only if it unlocks rate-limit upgrades, partner fee tiers, or transaction endpoints | `PAYTRIE_API_KEY` (optional in adapter; quotes work without it) |
| CADC-BASE access confirmation | Whether their transaction products cover CADC-BASE as well as USDC-BASE | Extends executable CAD legs |

## 5. Apaylo — CAD liquidity — `https://apaylo.com/`

| Request | Details | Unlocks |
|---|---|---|
| API documentation + sandbox credentials | Products: CAD collection/payout (Rails leg) | `APAYLO_API_BASE_URL`, `APAYLO_API_KEY` (new adapter) |
| Supported rails | EMT / wire / EFT settlement types and cut-off times | CAD leg routing |

## 6. Tetra Trust — CADD — `https://tetradg.com/cadd`

| Request | Details | Unlocks |
|---|---|---|
| CADD contract addresses per network | Registry shows Base support confirmed but address pending; also Solana/ETHEREUM/TEMPO claims | `ASSETS.CADD.contractAddresses` |
| API access / partner onboarding requirements | Whether Tetra offers API mint/redeem | CADDadapter |
| Base contract address + tests | Verified address for CADD on Base (`BASE: null` today) | CADD quote/settlement legs |

## 7. Nomba — NGN collection — `https://nomba.com/`

| Request | Details | Unlocks |
|---|---|---|
| Sandbox base URL | Verified domain: `https://sandbox.nomba.com` (returns 500 without auth — confirms sandbox exists but is key-gated) | `NOMBA_API_BASE_URL` |
| API documentation + sandbox API key | Products: NGN collections (virtual accounts), payouts | `NOMBA_API_KEY` (new adapter) |
| Webhook signature spec | For reconciliation | M5 |

## 8. Fincra — NGN payout + additional corridors — `https://fincra.com/`

| Request | Details | Unlocks |
|---|---|---|
| Sandbox base URL | Verified domain: `https://sandboxapi.fincra.com` (returns 404 without auth — confirms sandbox exists but is key-gated) | `FINCRA_API_BASE_URL` |
| API documentation + sandbox API key | NGN collections & payouts; confirm GHS/KES/UGX/XAF/XOF/ZAR support | `FINCRA_API_KEY` (new adapter) |
| Business onboarding requirements | Approved-sender prerequisites like Paycrest | M3 execution |

## 9. Strails — CNGN — `https://strails.co`

| Request | Details | Unlocks |
|---|---|---|
| Sandbox base URL | **No public sandbox base URL found.** Strails homepage loads but no `/api` or `/api-docs` path returns anything. You must obtain this directly from Strails. | `STRAILS_API_BASE_URL` |
| API docs + sandbox API key | CNGN mint/redeem or transfer rails | `STRAILS_API_KEY` (new adapter) |
| CNGN contract addresses & issuer details | `ASSETS.CNGN` is `PENDING_VERIFICATION` in `config/assets.js` | CNGN legs |

## 10. Circle — USDC mint/issuance — `https://www.circle.com/`

| Request | Details | Unlocks |
|---|---|---|
| Sandbox base URL | Verified domain: `https://api-sandbox.circle.com` (returns 307 redirect — confirms sandbox exists but is key-gated) | `CIRCLE_API_BASE_URL` |
| Circle Mint (or Circle Wallet) sandbox enrollment | For USDC↔USD conversion if Bridge is unsuitable | `CIRCLE_API_KEY` (new adapter) |
| Confirmation of Base USDC registration | Already verified on-chain (Base mainnet USDC address configured) | M4 settlement |

## 11. Bridge (Stripe) — USD/GBP/EUR — `https://bridge.xyz/`

| Request | Details | Unlocks |
|---|---|---|
| Sandbox base URL | Verified domain: `https://api.bridge.xyz` (returns 404 on root — domain exists, endpoints key-gated). Sandbox mode is controlled through sandbox-mode API keys generated inside your Bridge dashboard | `BRIDGE_API_BASE_URL` |
| Sandbox API key | Generated inside your Bridge dashboard | `BRIDGE_API_KEY` (new adapter) |
| Integration guide + sandbox keys | Confirm product scope: stablecoin issuance, on/off-ramp for USD/GBP/EUR | |
| KYC/API model | Whether customer onboarding flows through Bridge's KYC or StableX's Vove KYC | Compliance architecture decision |

## 12. CoinGecko (role clarification) — `https://www.coingecko.com/`

| Request | Details | Unlocks |
|---|---|---|
| Is it liquidity or reference pricing? | Assumed price-data aggregator, not liquidity | Reference-rate source for the routing engine (`COINGECKO_API_KEY` if Pro) |

---

## Clarifying questions for the contact (ask before requesting keys)

1. **"ZAND/ZAR"** — what is ZAND? (ZAR = South African rand; is ZAND a separate bank/entity?)
2. **"Coingekko"** — is this CoinGecko used for price feeds only, or as an execution venue?
3. **Solana leg** — is Solana in scope for stablecoin settlement, or Base-only for the pilot? (Codebase is Base-only today.)
4. **Bridge vs Circle** — who converts USD↔USDC (and GBP/EUR↔their stablecoins) in the intended flow?
5. **Priority corridors for the first live end-to-end corridor** — recommend CAD↔NGN (Paytrie/Apaylo + Nomba/Fincra) or NGN↔KES (Honeycoin/Paycrest).
6. For every provider: sandbox vs production, rate limits, and idempotency/webhook requirements.

---

## Security rules for handling credentials

- Values go into `.env` only; never into source control, chat, or browser code.
- Ask for **sandbox-specific** credentials first, not production.
- Readiness endpoints treat placeholder values (`key`, `your_sandbox_api_key`, …) as missing.
- Rotate the `STABLEX_OPERATOR_TOKEN` and `STABLEX_EVENT_INGESTION_TOKEN` before any real traffic.
