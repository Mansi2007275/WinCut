/**
 * The price series, read straight from where it is stored.
 *
 * The agent used to get its candles from the web app's `/api/candles`. That was
 * one dependency too many: a stale deploy, a protected preview URL or a cold
 * function was enough to blind the agent completely, and because the route
 * answers with an HTML error page rather than JSON, the failure arrived as a
 * JSON parse error that said nothing useful. An agent whose market view depends
 * on a web front end being healthy is an agent that stops trading for reasons
 * that have nothing to do with the market.
 *
 * So this reads Upstash directly - the same sorted set, the same key format and
 * the same member encoding that `web/src/lib/series.ts` writes, that
 * `/api/sample` feeds and that `bots/src/store.ts` also writes to. The folding
 * below is deliberately identical to the web app's `buildCandles`, because the
 * agent and the chart disagreeing about what the candles are would be a much
 * worse bug than either of them being wrong alone.
 *
 * The HTTP route stays as a fallback for the case where the agent is run
 * without Upstash credentials.
 */

import { UPSTASH_TOKEN, UPSTASH_URL } from "./config.js";

export const seriesConfigured = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

export type PointSource = "sample" | "backfill" | "trade";
export type PricePoint = { t: number; p: number; source: PointSource };

export type OhlcCandle = {
  /** Seconds, matching what the chart library wants. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** Must match `web/src/lib/series.ts`. */
const key = (poolId: string | number) => `wincut:px:${poolId}`;

export const BUCKET_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

function decode(member: string): PricePoint | null {
  const [t, p, source] = member.split("|");
  const time = Number(t);
  const price = Number(p);
  if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0) return null;
  return { t: time, p: price, source: (source as PointSource) ?? "sample" };
}

async function redis(commands: (string | number)[][]): Promise<unknown[]> {
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${UPSTASH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Upstash responded ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: string }[];
  const failed = body.find((r) => r.error);
  if (failed) throw new Error(`Upstash: ${failed.error}`);
  return body.map((r) => r.result);
}

/** Every stored point in a window, oldest first. */
export async function readPoints(
  poolId: string | number,
  fromMs: number,
  toMs: number,
): Promise<PricePoint[]> {
  if (!seriesConfigured) return [];
  const [raw] = await redis([["ZRANGE", key(poolId), fromMs, toMs, "BYSCORE"]]);
  const members = Array.isArray(raw) ? (raw as string[]) : [];
  return members
    .map(decode)
    .filter((p): p is PricePoint => p !== null)
    .sort((a, b) => a.t - b.t);
}

export async function firstPointAt(poolId: string | number): Promise<number | null> {
  if (!seriesConfigured) return null;
  const [raw] = await redis([["ZRANGE", key(poolId), 0, 0, "WITHSCORES"]]);
  const arr = Array.isArray(raw) ? (raw as string[]) : [];
  if (arr.length < 2) return null;
  const score = Number(arr[1]);
  return Number.isFinite(score) ? score : null;
}

/**
 * Folds points into OHLC buckets. Character-for-character the same logic as the
 * web app's, including the carry-forward: an empty bucket repeats the previous
 * close as a flat candle, because a gap reads as "the price did something we
 * are not showing you" while a flat candle correctly says the pool sat still.
 * Nothing is invented before the first point or after the last.
 */
export function buildCandles(points: PricePoint[], bucketMs: number, limit = 300): OhlcCandle[] {
  if (!points.length || bucketMs <= 0) return [];

  const sorted = [...points].sort((a, b) => a.t - b.t);
  const floor = (t: number) => Math.floor(t / bucketMs) * bucketMs;

  const buckets = new Map<number, PricePoint[]>();
  for (const pt of sorted) {
    const b = floor(pt.t);
    const list = buckets.get(b);
    if (list) list.push(pt);
    else buckets.set(b, [pt]);
  }

  const firstBucket = floor(sorted[0]!.t);
  const lastBucket = floor(sorted[sorted.length - 1]!.t);

  const out: OhlcCandle[] = [];
  let prevClose: number | null = null;

  for (let b = firstBucket; b <= lastBucket; b += bucketMs) {
    const inBucket = buckets.get(b);
    if (inBucket?.length) {
      const prices = inBucket.map((p) => p.p);
      const open = prevClose ?? prices[0]!;
      const close = prices[prices.length - 1]!;
      out.push({
        time: Math.floor(b / 1000),
        open,
        high: Math.max(open, ...prices),
        low: Math.min(open, ...prices),
        close,
        volume: inBucket.filter((p) => p.source !== "sample").length,
      });
      prevClose = close;
    } else if (prevClose !== null) {
      out.push({
        time: Math.floor(b / 1000),
        open: prevClose,
        high: prevClose,
        low: prevClose,
        close: prevClose,
        volume: 0,
      });
    }
  }

  return out.slice(-limit);
}

/** Candles for one pool, read and folded here. */
export async function candlesFor(
  poolId: string | number,
  timeframe: string,
  limit = 300,
): Promise<{ candles: OhlcCandle[]; points: number; collectingSince: number | null }> {
  const bucketMs = BUCKET_MS[timeframe] ?? BUCKET_MS["15m"]!;
  const now = Date.now();
  const from = now - limit * bucketMs;
  const [points, since] = await Promise.all([
    readPoints(poolId, from, now),
    firstPointAt(poolId),
  ]);
  return { candles: buildCandles(points, bucketMs, limit), points: points.length, collectingSince: since };
}
