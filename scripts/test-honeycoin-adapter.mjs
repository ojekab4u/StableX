import { getHoneycoinRate } from "../providers/providers/honeycoinService.js";

const result = await getHoneycoinRate({
  from: "NGN",
  to: "USDC",
  amount: 10000
});

console.log({
  provider: result.name,
  from: result.from,
  amount: result.fromAmount,
  to: result.to,
  convertedAmount: result.toAmount,
  rate: result.rate,
  quoteType: result.quoteType,
  executable: result.executable
});

