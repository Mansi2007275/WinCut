/**
 * Writes prices into the same series the chart reads.
 *
 * Deliberately the same key format and the same source labels as the web app's
 * own sampler (`web/src/lib/series.ts`), because the chart must not be able to
 * tell the difference: a price is a price whether the app's cron observed it or
 * this process did. What the label records is how it was observed, and that is
 * carried through honestly - `trade` only when a WinCut trade actually settled,
 * `sample` for a plain reserve read.
 */

import { UPSTASH_TOKEN, UPSTASH_URL } from "./config.js";

export const storeConfigured = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

export type PointSource = "sample" | "backfill" | "trade";

const key = (poolId: number | string) => `wincut:px:${poolId}`;

export async function storePoint(
  poolId: number | string,
  price: number,
  source: PointSource,
): Promise<void> {
  if (!storeConfigured) return;
  if (!(price > 0) || !Number.isFinite(price)) return;
  const t = Date.now();
  try {
    const res = await fetch(`${UPSTASH_URL}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${UPSTASH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify([["ZADD", key(poolId), String(t), `${t}|${price}|${source}`]]),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
  } catch {
    // A missed point is a gap in the chart, not a reason to stop trading.
  }
}
