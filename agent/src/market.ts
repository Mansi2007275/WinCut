/**
 * What the agent knows about the market, all of it read from a real source.
 *
 * Prices and depth come from the Rhea pool reserves, the same numbers the
 * trade screen quotes from. Candles come from whichever indexer exists for the
 * network: GeckoTerminal on mainnet, and on testnet the series WinCut builds
 * itself from on-chain samples, served by /api/candles.
 *
 * Nothing here invents a number. If a source is unavailable the field comes
 * back undefined and the decision is made without it - a missing input is a
 * reason to be cautious, not a reason to fill the gap with a guess.
 */

import { getPool, type TokenConfig } from "./chain.js";
import { NETWORK, TIMEFRAME, USDC_DECIMALS, WEB_BASE_URL } from "./config.js";
import { candlesFor, seriesConfigured } from "./series.js";

export type Candle = { time: number; open: number; high: number; low: number; close: number };

export type MarketView = {
  token: TokenConfig;
  /** Quote units per whole token, from the live reserves. */
  mid: number;
  /** Quote units held by the thinnest pool on the route. */
  liquidity: number;
  /** Compounded pool fee across the route, as a percent. */
  poolFeePct: number;
  candles: Candle[];
  /** Percent change over the candle window, when there are enough candles. */
  changePct?: number;
  /** Simple momentum: last close against the mean of the window. */
  momentumPct?: number;
  notes: string[];
};

const FEE_DIVISOR = 10_000;

/** Mid price along a route, walking the reserves hop by hop. */
function midAlongRoute(
  hops: { pool_id: number; token_in: string; token_out: string }[],
  pools: { token_account_ids: string[]; amounts: string[]; total_fee: number }[],
  decimalsOut: number,
): { mid: number; liquidity: number; feePct: number } {
  // Price one whole unit of the input token through every hop, without fees,
  // which is what "mid" means: the rate before the pool takes its cut.
  let amount = 1;
  let feeMultiplier = 1;
  let thinnest = Number.POSITIVE_INFINITY;
  let decimalsIn = USDC_DECIMALS;

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]!;
    const pool = pools[i]!;
    const inIdx = pool.token_account_ids.indexOf(hop.token_in);
    const outIdx = pool.token_account_ids.indexOf(hop.token_out);
    if (inIdx < 0 || outIdx < 0) throw new Error(`pool #${hop.pool_id} does not hold the hop's pair`);

    const reserveIn = Number(pool.amounts[inIdx]);
    const reserveOut = Number(pool.amounts[outIdx]);
    if (!(reserveIn > 0) || !(reserveOut > 0)) throw new Error(`pool #${hop.pool_id} has an empty side`);

    // Decimals of this hop's output: the last hop ends at the token itself.
    const dOut = i === hops.length - 1 ? decimalsOut : 24; // wNEAR hub is 24
    const rate = (reserveOut / 10 ** dOut) / (reserveIn / 10 ** decimalsIn);
    amount *= rate;

    feeMultiplier *= 1 - pool.total_fee / FEE_DIVISOR;
    thinnest = Math.min(thinnest, reserveIn / 10 ** decimalsIn);
    decimalsIn = dOut;
  }

  return {
    // `amount` is tokens per 1 quote unit; the price is its reciprocal.
    mid: amount > 0 ? 1 / amount : 0,
    liquidity: Number.isFinite(thinnest) ? thinnest : 0,
    feePct: (1 - feeMultiplier) * 100,
  };
}

async function fetchCandles(
  token: TokenConfig,
  tf = TIMEFRAME,
): Promise<{ candles: Candle[]; note?: string }> {
  if (NETWORK === "mainnet") {
    try {
      if (!token.chart_pool) return { candles: [], note: "no chart pool configured" };
      const url =
        `https://api.geckoterminal.com/api/v2/networks/near/pools/${token.chart_pool}` +
        `/ohlcv/minute?aggregate=15&limit=96&currency=usd&token=base`;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) return { candles: [], note: `GeckoTerminal responded ${res.status}` };
      const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
      const list = body.data?.attributes?.ohlcv_list ?? [];
      return {
        candles: list
          .map((c) => ({ time: c[0]!, open: c[1]!, high: c[2]!, low: c[3]!, close: c[4]! }))
          .reverse(),
      };
    } catch (e) {
      return { candles: [], note: `candles unavailable: ${(e as Error).message}` };
    }
  }

  // Testnet: WinCut's own series. The pool is the last hop of the route, which
  // is the pool whose price the token actually trades at.
  const pool = token.hops[token.hops.length - 1]?.pool_id;
  if (pool === undefined) return { candles: [], note: "token has no route" };

  // Straight from Upstash where possible. No web app in the path, so a stale
  // deploy cannot blind the agent.
  if (seriesConfigured) {
    try {
      const { candles } = await candlesFor(pool, tf);
      return { candles: candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })) };
    } catch (e) {
      return { candles: [], note: `series read failed: ${(e as Error).message}` };
    }
  }

  // Only without Upstash credentials: ask the web app instead. Its error pages
  // are HTML, so the status is checked before anything is parsed - otherwise a
  // stale deploy reports itself as a JSON syntax error, which explains nothing.
  try {
    const res = await fetch(`${WEB_BASE_URL}/api/candles?pool=${pool}&tf=${tf}`, {
      headers: { accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok || text.trimStart().startsWith("<")) {
      return {
        candles: [],
        note:
          `no Upstash credentials, and ${WEB_BASE_URL}/api/candles answered ` +
          `${res.status}${text.trimStart().startsWith("<") ? " with an HTML page - that deploy has no candles route" : ""}`,
      };
    }
    const body = JSON.parse(text) as { candles?: Candle[]; error?: string; detail?: string };
    if (body.error) return { candles: [], note: body.detail ?? body.error };
    return { candles: body.candles ?? [] };
  } catch (e) {
    return { candles: [], note: `candles unavailable: ${(e as Error).message}` };
  }
}

export async function readMarket(token: TokenConfig, refContract: string): Promise<MarketView> {
  const notes: string[] = [];
  const pools = [];
  for (const hop of token.hops) pools.push(await getPool(refContract, hop.pool_id));

  const { mid, liquidity, feePct } = midAlongRoute(token.hops, pools, token.decimals);
  const { candles, note } = await fetchCandles(token);
  if (note) notes.push(note);

  let changePct: number | undefined;
  let momentumPct: number | undefined;
  if (candles.length >= 2) {
    const first = candles[0]!.close;
    const last = candles[candles.length - 1]!.close;
    if (first > 0) changePct = ((last - first) / first) * 100;
    const mean = candles.reduce((s, c) => s + c.close, 0) / candles.length;
    if (mean > 0) momentumPct = ((last - mean) / mean) * 100;
  } else {
    notes.push(`only ${candles.length} candle(s) - not enough history to read a trend`);
  }

  return { token, mid, liquidity, poolFeePct: feePct, candles, changePct, momentumPct, notes };
}
