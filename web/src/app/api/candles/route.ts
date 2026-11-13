/**
 * Serves OHLC candles for a testnet pool, folded server-side from the price
 * points WinCut has collected from the chain.
 *
 * The folding happens here rather than in the browser so every viewer gets the
 * same buckets from one read, and so the chart component stays identical
 * between mainnet (GeckoTerminal) and testnet (this).
 *
 * The response carries its own provenance - how many points are behind it, when
 * collection started, and how many of them came from each source - so the chart
 * can say "collecting since <time>" honestly instead of drawing a thin line and
 * letting it look like a market.
 */

import { NextResponse } from "next/server";

import { BUCKET_MS, buildCandles, countPoints, firstPointAt, readPoints, seriesConfigured } from "@/lib/series";

export const dynamic = "force-dynamic";

const no = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/** How far back to read for each timeframe: enough for ~300 candles. */
const LOOKBACK: Record<string, number> = {
  "1m": 300 * BUCKET_MS["1m"],
  "5m": 300 * BUCKET_MS["5m"],
  "15m": 300 * BUCKET_MS["15m"],
  "1h": 300 * BUCKET_MS["1h"],
  "4h": 300 * BUCKET_MS["4h"],
  "1d": 365 * BUCKET_MS["1d"],
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const pool = url.searchParams.get("pool");
  const tf = url.searchParams.get("tf") ?? "15m";

  if (!pool) return no(400, { error: "pool is required" });
  if (!BUCKET_MS[tf]) {
    return no(400, { error: "unknown timeframe", tf, allowed: Object.keys(BUCKET_MS) });
  }
  if (!seriesConfigured) {
    return no(503, {
      error: "not collecting yet",
      detail:
        "Upstash is not configured, so WinCut has nowhere to keep the price points it reads from the chain. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      candles: [],
      points: 0,
      collectingSince: null,
    });
  }

  try {
    const now = Date.now();
    const from = now - (LOOKBACK[tf] ?? LOOKBACK["15m"]);
    const [points, total, since] = await Promise.all([
      readPoints(pool, from, now),
      countPoints(pool),
      firstPointAt(pool),
    ]);

    const candles = buildCandles(points, BUCKET_MS[tf], 300);
    const bySource = points.reduce<Record<string, number>>((acc, p) => {
      acc[p.source] = (acc[p.source] ?? 0) + 1;
      return acc;
    }, {});

    return NextResponse.json(
      {
        pool,
        tf,
        candles,
        points: points.length,
        pointsStoredAllTime: total,
        bySource,
        collectingSince: since ? new Date(since).toISOString() : null,
        source: "Rhea testnet pool price · on-chain",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return no(502, { error: "could not read the series", detail: (e as Error).message });
  }
}
