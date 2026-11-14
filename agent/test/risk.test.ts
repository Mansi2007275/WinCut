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
check("20% of balance passes unchanged", (() => {
  const v = buy(20);
  return v.ok && v.proposal.sizeUsdc === 20 && v.proposal.reason === "t";
})());
check("20.01% is trimmed to the cap, not refused", (() => {
  const v = buy(20.01);
  return v.ok && v.proposal.sizeUsdc === 20;
})());
// The regression that started this: a 114.53 balance gives a 22.906 cap, the
// model proposed 22.91, and the agent refused a trade for being four tenths of
// a cent over while printing both numbers rounded to 22.91.
check("a proposal a rounding error over the cap still trades", (() => {
  const v = vet(
    { action: "BUY", tokenId: "a.testnet", sizeUsdc: 22.91, reason: "t" },
    { ...base, balanceUsdc: 114.53 },
  );
  return v.ok && v.proposal.sizeUsdc === 22.9;
})());
check("a proposal exactly at an exact cap is untouched", (() => {
  // 100 * 0.2 is exactly 20, so nothing should be trimmed or renamed.
  const v = buy(20);
  return v.ok && !/trimmed/.test(v.proposal.reason);
})());
check("the trimmed size never exceeds the ceiling", (() => {
  const v = vet(
    { action: "BUY", tokenId: "a.testnet", sizeUsdc: 1000, reason: "t" },
    { ...base, balanceUsdc: 114.53 },
  );
  return v.ok && (v.proposal.sizeUsdc ?? 0) <= 114.53 * 0.2;
})());
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

console.log("the pool depth cap");
// 1.5% of a 400 tUSDC pool is 6, well under the 20 the balance cap allows -
// which is the whole point: the two limits answer different questions.
const depth = (usdc: number) => new Map([["a.testnet", usdc]]);
const buyIn = (sizeUsdc: number, poolUsdc: number) =>
  vet({ action: "BUY", tokenId: "a.testnet", sizeUsdc, reason: "t" }, { ...base, depthUsdc: depth(poolUsdc) });

check("a buy inside the pool cap passes unchanged", (() => {
  const v = buyIn(5, 400);
  return v.ok && v.proposal.sizeUsdc === 5 && v.proposal.reason === "t";
})());
check("a buy over the pool cap is trimmed, not refused", (() => {
  const v = buyIn(20, 400);
  return v.ok && v.proposal.sizeUsdc === 6;
})());
check("the lowest of the three ceilings wins", (() => {
  // balance cap 20, pool cap 6: the pool is lower, so 6.
  const v = buyIn(20, 400);
  if (!(v.ok && v.proposal.sizeUsdc === 6)) return false;
  // balance cap 2, pool cap 6: the balance is lower, so 2.
  const w = vet(
    { action: "BUY", tokenId: "a.testnet", sizeUsdc: 20, reason: "t" },
    { ...base, balanceUsdc: 10, depthUsdc: depth(400) },
  );
  return w.ok && w.proposal.sizeUsdc === 2;
})());
check("the trim is written into the reason", (() => {
  const v = buyIn(20, 400);
  return v.ok && /trimmed from 20\.00 to 6\.00/.test(v.proposal.reason);
})());
check("exactly at the cap is not trimmed", (() => {
  const v = buyIn(6, 400);
  return v.ok && v.proposal.sizeUsdc === 6 && v.proposal.reason === "t";
})());
check("a deep pool leaves the balance cap binding", (() => {
  const v = buyIn(20, 100_000);
  return v.ok && v.proposal.sizeUsdc === 20;
})());
check("a pool too thin for the minimum is refused", !buyIn(5, 50).ok);
check("no depth given means no pool cap", (() => {
  const v = vet({ action: "BUY", tokenId: "a.testnet", sizeUsdc: 20, reason: "t" }, base);
  return v.ok && v.proposal.sizeUsdc === 20;
})());
check("with a deep pool the balance cap is what binds", (() => {
  const v = vet(
    { action: "BUY", tokenId: "a.testnet", sizeUsdc: 50, reason: "t" },
    { ...base, depthUsdc: depth(100_000) },
  );
  return v.ok && v.proposal.sizeUsdc === 20 && /per-trade cap/.test(v.proposal.reason);
})());
check("the reason names the pool when the pool is what binds", (() => {
  const v = buyIn(20, 400);
  return v.ok && /pool cap/.test(v.proposal.reason);
})());

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
