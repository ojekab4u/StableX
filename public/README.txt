STABLEX BASE SEPOLIA FRONTEND DEMO

Files:
- base-demo.html
- base-demo.css
- base-demo.js

Installation:
1. Copy all three files into your existing project's public folder.
2. Do not overwrite index.html, app.js, style.css or your existing wallet integration.
3. Make sure Express serves the public directory (your existing app already does this).
4. Start the Node server.
5. Open http://localhost:3000/base-demo.html

What the page demonstrates:
- Simulated provider quote comparison through GET /api/quotes.
- EIP-6963 wallet discovery, with an injected-wallet fallback.
- Wallet connection and switch to Base Sepolia.
- Live Base Sepolia ETH, USDC and EURC balance reads.
- A wallet-signed ERC-20 USDC test transfer, with simulation, receipt and BaseScan link.
- Evidence card for the previously confirmed 1 USDC CLI transaction reported by the user.

Requirements and cautions:
- Your server must expose GET /api/quotes and return { amount, from, to, mode, disclaimer, quotes }.
- The page uses the public Base Sepolia RPC from the browser and imports viem 2.57.12 from esm.sh.
- Connect the wallet that holds the test USDC. The previously demonstrated sender was 0x99DeA1c204ea2e0E71d17C7C87AA97750556b618.
- The prefilled recipient is the second wallet used in the prior demonstration. Change it if needed.
- Any transfer initiated from this page is an actual Base Sepolia transaction using test tokens, not a real-money transfer.
- Never put a private key or seed phrase into these frontend files.
- Do not present the simulated FX quote cards as live executable liquidity offers.
