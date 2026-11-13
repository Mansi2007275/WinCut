import { RISK } from "../src/config.js";
import { forcedExit, positionState, vet, type PositionState } from "../src/risk.js";
import type { PositionView } from "../src/chain.js";

const pos = (symbol: string, amount: string, basis: string): PositionView => ({
  token_id: `${symbol.toLowerCase()}.testnet`,
  symbol,
  decimals: 24,
  amount,
  cost_basis_usdc: basis,
});

const known = new Set(["a.testnet", "b.testnet", "c.testnet", "d.testnet"]);
let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

// One whole token held, cost basis 100 tUSDC.
const one = (symbol: string, mid: number) =>
  positionState(pos(symbol, (10n ** 24n).toString(), (100n * 10n ** 6n).toString()), mid);

console.log("forced exits");
check("stop loss at -8% fires", forcedExit([one("A", 92)])?.action === "SELL");
check("-7.9% does not fire", forcedExit([one("A", 92.1)]) === null);
check("take profit at +12% fires", forcedExit([one("A", 112)])?.action === "SELL");
check("+11.9% does not fire", forcedExit([one("A", 111.9)]) === null);
check("a forced exit sells the whole position", forcedExit([one("A", 92)])?.sellFraction === 1);

console.log("buy limits");
const base = { balanceUsdc: 100, states: [] as PositionState[], tradesLast24h: 0, knownTokens: known };
const buy = (sizeUsdc: number, over: Partial<typeof base> = {}) =>
  vet({ action: "BUY", tokenId: "a.testnet", sizeUsdc, reason: "t" }, { ...base, ...over });

check("20% of balance is allowed", buy(20).ok);
check("20.01% is refused", !buy(20.01).ok);
check("size below the minimum is refused", !buy(RISK.minTradeUsdc - 0.01).ok);
check("an unlisted token is refused", !vet({ action: "BUY", tokenId: "nope.testnet", sizeUsdc: 5, reason: "t" }, base).ok);
check("no token at all is refused", !vet({ action: "BUY", sizeUsdc: 5, reason: "t" }, base).ok);

const three = [one("A", 100), one("B", 100), one("C", 100)];
three[0]!.position.token_id = "a.testnet";
three[1]!.position.token_id = "b.testnet";
three[2]!.position.token_id = "c.testnet";
check("a 4th position is refused", !vet({ action: "BUY", tokenId: "d.testnet", sizeUsdc: 5, reason: "t" }, { ...base, states: three }).ok);
check("adding to one of the 3 held is allowed", vet({ action: "BUY", tokenId: "a.testnet", sizeUsdc: 5, reason: "t" }, { ...base, states: three }).ok);
check("the daily cap is refused", !buy(5, { tradesLast24h: RISK.maxTradesPerDay }).ok);
check("one under the daily cap is allowed", buy(5, { tradesLast24h: RISK.maxTradesPerDay - 1 }).ok);

console.log("sell limits");
const held = { ...base, states: [one("A", 100)] };
held.states[0]!.position.token_id = "a.testnet";
check("selling what is held is allowed", vet({ action: "SELL", tokenId: "a.testnet", sellFraction: 0.5, reason: "t" }, held).ok);
check("selling what is not held is refused", !vet({ action: "SELL", tokenId: "b.testnet", sellFraction: 1, reason: "t" }, held).ok);
check("a fraction above 1 is refused", !vet({ action: "SELL", tokenId: "a.testnet", sellFraction: 1.5, reason: "t" }, held).ok);
check("a zero fraction is refused", !vet({ action: "SELL", tokenId: "a.testnet", sellFraction: 0, reason: "t" }, held).ok);
check("a sell past the daily cap is refused", !vet({ action: "SELL", tokenId: "a.testnet", sellFraction: 1, reason: "t" }, { ...held, tradesLast24h: RISK.maxTradesPerDay }).ok);

console.log("hold");
check("HOLD always passes", vet({ action: "HOLD", reason: "t" }, base).ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
