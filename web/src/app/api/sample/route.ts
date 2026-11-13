/**
 * Samples the live pool price from the chain and stores it as one point.
 *
 * This is what gives the testnet chart a time axis. GeckoTerminal does not
 * index testnet, so unless something reads the pool on a schedule there is no
 * series to draw at all. A cron (cron-job.org, or Vercel Cron) calls this every
 * minute; see docs/DEPLOY.md.
 *
 * The price is the pool mid, computed from the reserves the exchange reports
 * right now - the same number the trade screen shows. Nothing is generated.
 *
 * Guarded by a shared secret in `x-cron-secret`, because an open endpoint that
 * writes to storage is an invitation to fill it with junk.
 */

import { NextResponse } from "next/server";

import { CONTRACT_ID, isDeployed, NETWORK, USDC_DECIMALS } from "@/lib/near";
import * as contract from "@/lib/contract";
import * as rhea from "@/lib/rhea";
import { addPoints, seriesConfigured, type PricePoint } from "@/lib/series";

export const dynamic = "force-dynamic";

const no = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return no(503, { error: "CRON_SECRET is not set, so sampling is disabled" });
  }
  if (request.headers.get("x-cron-secret") !== secret) {
    return no(401, { error: "bad or missing x-cron-secret" });
  }
  if (!seriesConfigured) {
    return no(503, {
      error: "Upstash is not configured",
      detail: "set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN",
    });
  }
  if (NETWORK !== "testnet") {
    return no(400, {
      error: "sampling is for testnet only",
      detail: "on mainnet the candles come from GeckoTerminal, which indexes the chain already",
    });
  }
  if (!isDeployed) {
    return no(503, { error: "NEXT_PUBLIC_CONTRACT_ID is not set, so there are no markets to sample" });
  }

  const startedAt = Date.now();
  try {
    const tokens = await contract.getTokens();
    const now = Date.now();
    const sampled: { pool: string; symbol: string; price: number; added: number }[] = [];
    const failed: { symbol: string; error: string }[] = [];

    for (const token of tokens) {
      try {
        // The route's own pools, read live - the same source the order panel
        // quotes from, so the chart and the quote cannot disagree.
        const pools = await rhea.loadRoute(token.hops);
        const buy = rhea.sides(token.hops, pools, false);
        const mid = rhea.midPrice(buy, USDC_DECIMALS, token.decimals);
        if (!Number.isFinite(mid) || mid <= 0) {
          failed.push({ symbol: token.symbol, error: "the reserves did not give a usable mid price" });
          continue;
        }

        const poolKey = poolKeyFor(token.hops);
        const point: PricePoint = { t: now, p: mid, source: "sample" };
        const added = await addPoints(poolKey, [point]);
        sampled.push({ pool: poolKey, symbol: token.symbol, price: mid, added });
      } catch (e) {
        failed.push({ symbol: token.symbol, error: (e as Error).message });
      }
    }

    return no(sampled.length ? 200 : 502, {
      ok: sampled.length > 0,
      network: NETWORK,
      contract: CONTRACT_ID,
      at: new Date(now).toISOString(),
      tookMs: Date.now() - startedAt,
      sampled,
      failed,
    });
  } catch (e) {
    return no(502, { error: "could not sample the pools", detail: (e as Error).message });
  }
}

/**
 * The series key for a token's route. The last hop's pool is the one whose
 * price actually moves the token, so that is what the series is named for.
 */
export function poolKeyFor(hops: { pool_id: number }[]): string {
  return String(hops[hops.length - 1]?.pool_id ?? "unknown");
}
