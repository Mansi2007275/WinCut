/**
 * What the model is actually shown.
 *
 * The agent had a working brain that still would not trade two of its four
 * markets, because the prompt told it `price 0.000000` for both and it
 * concluded their trends could not be read. It was right to conclude that from
 * what it was given. So these tests are about the prompt as a piece of
 * reporting: a price must survive being written down, and the fields a decision
 * rests on must not change size with the token.
 */

import { buildPrompt, candleMoves, fallbackDecision } from "../src/brain.js";
import type { MarketView } from "../src/market.js";
import type { PositionState } from "../src/risk.js";
import { positionState } from "../src/risk.js";
import type { PositionView } from "../src/chain.js";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

const candles = (...closes: number[]) =>
  closes.map((close, i) => ({ time: i, open: close, high: close, low: close, close, volume: 0 }));

const market = (symbol: string, mid: number, closes: number[] = []): MarketView => ({
  token: {
    token_id: `${symbol.toLowerCase()}.tkn.primitives.testnet`,
    symbol,
    decimals: 6,
    hops: [],
    registered: true,
    chart_pool: "",
  } as unknown as MarketView["token"],
  mid,
  liquidity: 400,
  poolFeePct: 0.3,
  candles: candles(...closes) as unknown as MarketView["candles"],
  changePct: closes.length > 1 ? 1.5 : undefined,
  momentumPct: closes.length > 1 ? 0.55 : undefined,
  notes: [],
});

console.log("candle moves");
check("two closes give one move", candleMoves(candles(100, 101)) === "+1.00%");
check("a fall is signed", candleMoves(candles(100, 99)) === "-1.00%");
check("a flat close reads as +0.00%", candleMoves(candles(100, 100)) === "+0.00%");
check("one close is not enough", candleMoves(candles(100)) === "not enough closes to compare");
check("no closes is not enough", candleMoves([]) === "not enough closes to compare");
check("it reports at most n moves", candleMoves(candles(1, 2, 3, 4, 5, 6, 7, 8, 9), 3).split(" ").length === 3);
check("it reports the most recent moves", candleMoves(candles(100, 1, 2), 1) === "+100.00%");
check("a zero close cannot divide", candleMoves(candles(0, 5)) === "n/a");

// The point of the whole change: a 5.6e-9 token and a $3 token produce moves of
// the same magnitude, so the model never reasons about absolute scale.
check("scale does not change the moves", (() => {
  const big = candleMoves(candles(3.4, 3.434));
  const tiny = candleMoves(candles(5.54e-9, 5.5954e-9));
  return big === tiny && big === "+1.00%";
})());

console.log("the prompt");
const markets = [
  market("MNEAR", 3.4089, [3.4, 3.41, 3.4089]),
  market("MDRAGON", 5.5407e-9, [5.5e-9, 5.54e-9, 5.5407e-9]),
  market("MLONK", 1.22832e-7, [1.22e-7, 1.228e-7, 1.22832e-7]),
];
const { system, user } = buildPrompt(markets, [], 114.53, 0);

check("a tiny price is never written as zero", !/price 0\.000000/.test(user), user.slice(0, 400));
check("MDRAGON's price survives", /5\.54070e-9/.test(user));
check("MLONK's price survives", /1\.22832e-7/.test(user));
check("a normal price still reads normally", /3\.408900/.test(user));
check("every market carries its moves", (user.match(/last moves/g) ?? []).length === 3);
check("the moves are percentages", /last moves \+0\.29% -0\.03%/.test(user));
check("the system prompt warns about scale", /5\.54070e-9 is a real, readable price/.test(system));

// A held position is reported the same way, since entry and mid have the same
// problem and the stop loss is read off them.
const held: PositionView = {
  token_id: "mdragon.tkn.primitives.testnet",
  symbol: "MDRAGON",
  decimals: 6,
  amount: (1_000_000_000n * 10n ** 6n).toString(),
  cost_basis_usdc: (6n * 10n ** 6n).toString(),
};
const states: PositionState[] = [positionState(held, 5.5407e-9)];
const withPosition = buildPrompt(markets, states, 114.53, 0).user;
check("a position's entry is not written as zero", !/entry 0\.000000/.test(withPosition));
check("a position's current price is not written as zero", !/now 0\.000000/.test(withPosition));

console.log("the fallback reads the same markets");
check("the fallback can act on a tiny-priced market", (() => {
  // momentum 0.55% clears the 0.35% entry, so it should buy something.
  const d = fallbackDecision(markets, [], 114.53);
  return d.action === "BUY" && !!d.tokenId;
})());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
