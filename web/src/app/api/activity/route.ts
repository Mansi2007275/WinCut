/**
 * 24h volume and buy/sell pressure for one market, from what actually traded.
 *
 * On mainnet GeckoTerminal answers both questions, because it indexes the pool.
 * On testnet nothing indexes anything, and the old panels said so - which was
 * honest but not useful, since WinCut does know what traded through it. The
 * contract keeps its last 500 settled trades on chain with their notionals and
 * sides, which is a better source than an indexer for the part of the activity
 * that went through WinCut: it is the settlement record itself.
 *
 * Two sources are merged here, and the response names both:
 *
 *   wincut  every settled buy and sell on this token, from the contract's own
 *           trade ring. Real notionals, not estimates.
 *   maker   the market maker's swaps, which go to Rhea directly and therefore
 *           never reach WinCut's trade log. Recorded by the maker itself as it
 *           swaps. Counting them matters because leaving them out would
 *           understate how much the pool really traded.
 *
 * The response carries `truncated` when the contract's ring is full and older
 * trades may have aged out of it, so the UI can say "at least" rather than
 * quietly reporting a floor as a total.
 */

import { NextResponse } from "next/server";

import * as contract from "@/lib/contract";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The contract's trade ring capacity. */
const RING = 500;

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

type MakerSwap = { t: number; usdc: number; side: "buy" | "sell" };

async function makerSwaps(poolId: string, sinceMs: number): Promise<MakerSwap[] | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([["ZRANGE", `wincut:mm:${poolId}`, String(sinceMs), "+inf", "BYSCORE"]]),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown; error?: string }[];
    if (body[0]?.error) return null;
    const members = (body[0]?.result as string[] | null) ?? [];
    const out: MakerSwap[] = [];
    for (const m of members) {
      const [t, usdc, side] = m.split("|");
      const time = Number(t);
      const value = Number(usdc);
      if (!Number.isFinite(time) || !Number.isFinite(value) || value <= 0) continue;
      out.push({ t: time, usdc: value, side: side === "sell" ? "sell" : "buy" });
    }
    return out;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenId = url.searchParams.get("token");
  const poolId = url.searchParams.get("pool");

  if (!tokenId) return json({ error: "token is required" }, 400);

  const since = Date.now() - DAY_MS;
  const sinceNs = BigInt(since) * 1_000_000n;

  let trades: contract.Trade[];
  try {
    trades = await contract.getRecentTrades(0, RING);
  } catch (e) {
    return json({ error: "could not read the contract's trades", detail: (e as Error).message }, 502);
  }

  const mine = trades.filter((t) => {
    if (t.token_id !== tokenId) return false;
    try {
      return BigInt(t.timestamp) >= sinceNs;
    } catch {
      return false;
    }
  });

  const usdcOf = (t: contract.Trade) => Number(t.usdc) / 1e6;
  let buys = mine.filter((t) => t.side === "Buy").reduce((s, t) => s + usdcOf(t), 0);
  let sells = mine.filter((t) => t.side === "Sell").reduce((s, t) => s + usdcOf(t), 0);
  let count = mine.length;

  const sources = ["wincut"];
  let makerCount = 0;
  let makerVolume = 0;

  if (poolId) {
    const swaps = await makerSwaps(poolId, since);
    if (swaps) {
      sources.push("maker");
      makerCount = swaps.length;
      for (const s of swaps) {
        makerVolume += s.usdc;
        if (s.side === "buy") buys += s.usdc;
        else sells += s.usdc;
      }
      count += swaps.length;
    }
  }

  const volume = buys + sells;

  return json({
    tokenId,
    poolId,
    windowHours: 24,
    volume24hUsd: volume,
    buys,
    sells,
    buyPct: volume > 0 ? (buys / volume) * 100 : null,
    count,
    wincutCount: mine.length,
    makerCount,
    makerVolume,
    sources,
    // The ring holds the last 500 trades across every market. Once it is full,
    // a 24h window may reach further back than the ring does.
    truncated: trades.length >= RING,
    source: "WinCut settled trades" + (sources.includes("maker") ? " + market-maker swaps" : ""),
  });
}
