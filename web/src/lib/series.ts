/**
 * The on-chain price series behind the testnet chart.
 *
 * On mainnet the candles come from GeckoTerminal, which indexes the chain for
 * us. GeckoTerminal does not cover testnet at all, so on testnet WinCut has to
 * be its own indexer: every price point here was read from the chain by this
 * app and written to a sorted set, scored by timestamp.
 *
 * Three things write points, and all three are real on-chain prices - nothing
 * here is generated, interpolated or carried over from mainnet:
 *
 *   sample   a cron hitting /api/sample reads the pool reserves and stores the
 *            mid price. This is what gives the chart a time axis at all.
 *   backfill /api/backfill walks historical swaps on the exchange and stores
 *            the price each one actually executed at.
 *   trade    a settled WinCut buy or sell stores the price it filled at.
 *
 * Storage is Upstash Redis over its REST API, so it works from a Vercel
 * function with no connection pooling and no extra dependency. One sorted set
 * per pool: score is the timestamp in ms, member encodes the price and which
 * of the three sources wrote it.
 *
 * Everything degrades rather than throws. With no Upstash credentials
 * configured the store reports itself unconfigured and reads come back empty,
 * so the app still builds, still runs, and says plainly that it is not
 * collecting yet instead of showing an invented line.
 */

const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** False when Upstash is not configured; every read then returns nothing. */
export const seriesConfigured = Boolean(URL_ && TOKEN);

export type PointSource = "sample" | "backfill" | "trade";

export type PricePoint = {
  /** Milliseconds. */
  t: number;
  /** Quote-token units per whole base token. */
  p: number;
  source: PointSource;
};

export class SeriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeriesError";
  }
}

const key = (poolId: string) => `wincut:px:${poolId}`;

/** Points are encoded into the member so identical writes collapse. */
const encode = (pt: PricePoint) => `${pt.t}|${pt.p}|${pt.source}`;

function decode(member: string): PricePoint | null {
  const [t, p, source] = member.split("|");
  const time = Number(t);
  const price = Number(p);
  if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0) return null;
  return { t: time, p: price, source: (source as PointSource) ?? "sample" };
}

async function redis(commands: (string | number)[][]): Promise<unknown[]> {
  if (!seriesConfigured) throw new SeriesError("Upstash is not configured");
  const res = await fetch(`${URL_}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new SeriesError(`Upstash responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { result?: unknown; error?: string }[];
  const failed = body.find((r) => r.error);
  if (failed) throw new SeriesError(`Upstash command failed: ${failed.error}`);
  return body.map((r) => r.result);
}

/**
 * Writes points, newest-wins on collision. Returns how many commands were
 * sent, not how many were new - Redis reports new members per ZADD and we sum
 * that instead, so a re-run of the backfill reports 0 rather than lying.
 */
export async function addPoints(poolId: string, points: PricePoint[]): Promise<number> {
  const usable = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.p) && p.p > 0);
  if (!usable.length) return 0;

  let added = 0;
  // Upstash caps a pipeline body; 500 at a time is comfortably inside it.
  for (let i = 0; i < usable.length; i += 500) {
    const chunk = usable.slice(i, i + 500);
    const results = await redis(chunk.map((pt) => ["ZADD", key(poolId), pt.t, encode(pt)]));
    added += results.reduce<number>((n, r) => n + (typeof r === "number" ? r : 0), 0);
  }
  return added;
}

export const addPoint = (poolId: string, point: PricePoint) => addPoints(poolId, [point]);

/** Every stored point in a window, oldest first. Empty when unconfigured. */
export async function readPoints(poolId: string, fromMs: number, toMs: number): Promise<PricePoint[]> {
  if (!seriesConfigured) return [];
  const [raw] = await redis([["ZRANGE", key(poolId), fromMs, toMs, "BYSCORE"]]);
  const members = Array.isArray(raw) ? (raw as string[]) : [];
  return members
    .map(decode)
    .filter((p): p is PricePoint => p !== null)
    .sort((a, b) => a.t - b.t);
}

/** When collection started for a pool, so the UI can say "since <time>". */
export async function firstPointAt(poolId: string): Promise<number | null> {
  if (!seriesConfigured) return null;
  const [raw] = await redis([["ZRANGE", key(poolId), 0, 0, "WITHSCORES"]]);
  const arr = Array.isArray(raw) ? (raw as string[]) : [];
  if (arr.length < 2) return null;
  const score = Number(arr[1]);
  return Number.isFinite(score) ? score : null;
}

export async function countPoints(poolId: string): Promise<number> {
  if (!seriesConfigured) return 0;
  const [raw] = await redis([["ZCARD", key(poolId)]]);
  return typeof raw === "number" ? raw : 0;
}

// --------------------------------------------------------------- candles

/** Bucket widths, matching the six timeframes the chart offers. */
export const BUCKET_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export type OhlcCandle = {
  /** Seconds, as lightweight-charts wants it. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Folds points into OHLC buckets.
 *
 * Empty buckets carry the previous close forward as a flat candle rather than
 * being skipped, because a gap in a time series reads as "the price did
 * something we are not showing you". A testnet pool genuinely does sit
 * unchanged between trades, and a flat candle says exactly that.
 *
 * Carry-forward only ever fills buckets *between* real points. Nothing is
 * invented before the first point or after the last one.
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

  const firstBucket = floor(sorted[0].t);
  const lastBucket = floor(sorted[sorted.length - 1].t);

  const out: OhlcCandle[] = [];
  let prevClose: number | null = null;

  for (let b = firstBucket; b <= lastBucket; b += bucketMs) {
    const inBucket = buckets.get(b);
    if (inBucket?.length) {
      const prices = inBucket.map((p) => p.p);
      const open = prevClose ?? prices[0];
      const close = prices[prices.length - 1];
      out.push({
        time: Math.floor(b / 1000),
        open,
        high: Math.max(open, ...prices),
        low: Math.min(open, ...prices),
        close,
        // A sampled point is an observation, not a trade; only real trades and
        // backfilled swaps represent volume, and we do not have their sizes
        // here, so volume stays at the count of price-moving points.
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
