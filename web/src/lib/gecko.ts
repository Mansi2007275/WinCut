/**
 * GeckoTerminal: candles, 24h stats and recent swaps for a Rhea pool.
 *
 * Everything goes through this app's own `/api/gt/...` proxy, never straight
 * to GeckoTerminal - see that route for why.
 *
 * One wrinkle shapes this whole module. GeckoTerminal reports a pool from the
 * base token's point of view, and which token is "base" is whatever the pool
 * says. The deepest USDC pool on NEAR is `USDC / wNEAR`, so asking for its
 * price gives $1.00 - USDC's price, not wNEAR's. Every call here therefore
 * resolves which side the token being charted sits on, and asks for that side.
 */

export type GtSide = "base" | "quote";

export type PoolStats = {
  poolId: string;
  name: string;
  /** USD price of the token asked for, not of the pool's base token. */
  priceUsd: number;
  change24hPct: number;
  volume24hUsd: number;
  liquidityUsd: number;
  buys24h: number;
  sells24h: number;
  /** Which side of the pool the requested token is on. */
  side: GtSide;
};

export type Candle = {
  /** Seconds, as lightweight-charts wants it. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type PoolTrade = {
  id: string;
  side: "buy" | "sell";
  volumeUsd: number;
  priceUsd: number;
  timestamp: number;
  txHash: string;
};

export type Timeframe = {
  label: string;
  /** GeckoTerminal bucket. */
  unit: "minute" | "hour" | "day";
  aggregate: number;
  /** How often to re-poll, in ms. */
  pollMs: number;
};

export const TIMEFRAMES: Record<string, Timeframe> = {
  "1m": { label: "1m", unit: "minute", aggregate: 1, pollMs: 15_000 },
  "5m": { label: "5m", unit: "minute", aggregate: 5, pollMs: 20_000 },
  "15m": { label: "15m", unit: "minute", aggregate: 15, pollMs: 30_000 },
  "1h": { label: "1h", unit: "hour", aggregate: 1, pollMs: 60_000 },
  "4h": { label: "4h", unit: "hour", aggregate: 4, pollMs: 60_000 },
  "1d": { label: "1d", unit: "day", aggregate: 1, pollMs: 120_000 },
};

export const TIMEFRAME_KEYS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type TimeframeKey = (typeof TIMEFRAME_KEYS)[number];

export class GeckoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeckoError";
  }
}

async function gt<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/gt/${path}`, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      /* keep the status */
    }
    throw new GeckoError(detail, res.status);
  }
  return res.json() as Promise<T>;
}

type GtPool = {
  id: string;
  attributes: {
    name: string;
    base_token_price_usd: string | null;
    quote_token_price_usd: string | null;
    reserve_in_usd: string | null;
    volume_usd: Record<string, string>;
    price_change_percentage: Record<string, string>;
    transactions?: Record<string, { buys?: number; sells?: number }>;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
  };
};

const num = (v: string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Strips GeckoTerminal's `near_` prefix off a token id. */
const bare = (id: string) => id.replace(/^near_/, "");

/**
 * Pool stats, priced from `tokenId`'s side.
 *
 * `change24hPct` is read from whichever side was asked for and flipped when
 * that is the quote side, because a 5% rise in wNEAR against USDC is a 5% fall
 * in USDC against wNEAR, and the pool only reports the base token's figure.
 */
export async function poolStats(
  poolId: string,
  tokenId: string,
  signal?: AbortSignal,
): Promise<PoolStats> {
  const { data } = await gt<{ data: GtPool }>(`networks/near/pools/${poolId}`, signal);
  const a = data.attributes;
  const baseIsToken = bare(data.relationships.base_token.data.id) === tokenId;
  const side: GtSide = baseIsToken ? "base" : "quote";
  const priceUsd = baseIsToken ? num(a.base_token_price_usd) : num(a.quote_token_price_usd);
  const change = num(a.price_change_percentage?.h24);
  const tx = a.transactions?.h24;

  return {
    poolId,
    name: a.name,
    priceUsd,
    change24hPct: baseIsToken ? change : -change,
    volume24hUsd: num(a.volume_usd?.h24),
    liquidityUsd: num(a.reserve_in_usd),
    buys24h: tx?.buys ?? 0,
    sells24h: tx?.sells ?? 0,
    side,
  };
}

/** Stats for several pools in one request, for the landing page and board. */
export async function manyPoolStats(
  pools: { poolId: string; tokenId: string }[],
  signal?: AbortSignal,
): Promise<Map<string, PoolStats>> {
  const out = new Map<string, PoolStats>();
  if (pools.length === 0) return out;
  const ids = pools.map((p) => p.poolId).join(",");
  const { data } = await gt<{ data: GtPool[] }>(`networks/near/pools/multi/${ids}`, signal);
  for (const pool of data ?? []) {
    const id = pool.id.replace(/^near_/, "");
    const want = pools.find((p) => p.poolId === id);
    if (!want) continue;
    const a = pool.attributes;
    const baseIsToken = bare(pool.relationships.base_token.data.id) === want.tokenId;
    const change = num(a.price_change_percentage?.h24);
    out.set(id, {
      poolId: id,
      name: a.name,
      priceUsd: baseIsToken ? num(a.base_token_price_usd) : num(a.quote_token_price_usd),
      change24hPct: baseIsToken ? change : -change,
      volume24hUsd: num(a.volume_usd?.h24),
      liquidityUsd: num(a.reserve_in_usd),
      buys24h: a.transactions?.h24?.buys ?? 0,
      sells24h: a.transactions?.h24?.sells ?? 0,
      side: baseIsToken ? "base" : "quote",
    });
  }
  return out;
}

/**
 * OHLCV candles for a pool, priced from `side`.
 *
 * GeckoTerminal returns newest first; lightweight-charts needs oldest first and
 * strictly ascending, so the list is reversed and de-duplicated here rather
 * than in the chart component.
 */
export async function candles(
  poolId: string,
  tf: Timeframe,
  side: GtSide,
  limit = 300,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const qs = new URLSearchParams({
    aggregate: String(tf.aggregate),
    limit: String(limit),
    currency: "usd",
    token: side,
  });
  const { data } = await gt<{
    data: { attributes: { ohlcv_list: number[][] } };
  }>(`networks/near/pools/${poolId}/ohlcv/${tf.unit}?${qs}`, signal);

  const rows = data?.attributes?.ohlcv_list ?? [];
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const [time, open, high, low, close, volume] = rows[i];
    if (!Number.isFinite(time) || seen.has(time)) continue;
    seen.add(time);
    out.push({ time, open, high, low, close, volume: volume ?? 0 });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Recent swaps on the pool, for the buy/sell pressure bar.
 *
 * `kind` is reported from the base token's point of view, so on a USDC-base
 * pool a "sell" of USDC is somebody buying the other side. The flip keeps
 * "buy" meaning "bought the token this page is about".
 */
export async function poolTrades(
  poolId: string,
  side: GtSide,
  signal?: AbortSignal,
): Promise<PoolTrade[]> {
  const { data } = await gt<{
    data: {
      id: string;
      attributes: {
        kind: string;
        volume_in_usd: string;
        price_to_in_currency_token?: string;
        price_from_in_currency_token?: string;
        block_timestamp: string;
        tx_hash: string;
      };
    }[];
  }>(`networks/near/pools/${poolId}/trades`, signal);

  return (data ?? []).map((t) => {
    const raw = t.attributes.kind === "buy" ? "buy" : "sell";
    const flipped: "buy" | "sell" = side === "base" ? raw : raw === "buy" ? "sell" : "buy";
    return {
      id: t.id,
      side: flipped,
      volumeUsd: num(t.attributes.volume_in_usd),
      priceUsd: num(
        side === "base"
          ? t.attributes.price_from_in_currency_token
          : t.attributes.price_to_in_currency_token,
      ),
      timestamp: Date.parse(t.attributes.block_timestamp),
      txHash: t.attributes.tx_hash,
    };
  });
}
