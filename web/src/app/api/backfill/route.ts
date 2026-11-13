/**
 * Recovers a pool's historical swap prices from the chain and stores them.
 *
 * Run once per pool, not on a schedule - it is a one-off enrichment of the
 * series that /api/sample keeps adding to. It is slow on purpose: NearBlocks'
 * free tier allows roughly six requests a minute and this throttles to stay
 * inside that, so a full run takes minutes rather than seconds.
 *
 * Guarded by the same `x-cron-secret` as the sampler, because it writes.
 */

import { NextResponse } from "next/server";

import { NETWORK, REF_CONTRACT, USDC_ID, USDC_DECIMALS, isDeployed } from "@/lib/near";
import * as contract from "@/lib/contract";
import { backfillPool } from "@/lib/nearblocks";
import { addPoints, seriesConfigured } from "@/lib/series";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const no = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return no(503, { error: "CRON_SECRET is not set, so backfilling is disabled" });
  if (request.headers.get("x-cron-secret") !== secret) {
    return no(401, { error: "bad or missing x-cron-secret" });
  }
  if (NETWORK !== "testnet") {
    return no(400, { error: "backfill is for testnet only; mainnet uses GeckoTerminal" });
  }
  if (!isDeployed) return no(503, { error: "NEXT_PUBLIC_CONTRACT_ID is not set" });

  const url = new URL(request.url);
  const only = url.searchParams.get("token");
  const maxPages = Math.min(Number(url.searchParams.get("pages") ?? 6) || 6, 20);
  const dryRun = url.searchParams.get("dry") === "1";

  if (!dryRun && !seriesConfigured) {
    return no(503, {
      error: "Upstash is not configured",
      detail: "set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or call with ?dry=1",
    });
  }

  const startedAt = Date.now();
  try {
    const tokens = (await contract.getTokens()).filter((t) => !only || t.token_id === only);
    if (!tokens.length) return no(404, { error: "no listed token matched", token: only });

    const results = [];
    let totalPriced = 0;
    let totalStored = 0;

    for (const token of tokens) {
      const lastHop = token.hops[token.hops.length - 1];
      // The last hop is what prices the token. Its other side is the quote for
      // this hop - USDC on a one-hop route, wNEAR on a two-hop one.
      const quoteToken = lastHop.token_in;
      const quoteDecimals = quoteToken === USDC_ID ? USDC_DECIMALS : 24;

      const report = await backfillPool({
        poolKey: String(lastHop.pool_id),
        baseToken: token.token_id,
        baseDecimals: token.decimals,
        quoteToken,
        quoteDecimals,
        exchange: REF_CONTRACT,
        maxPages,
        network: "testnet",
      });

      let stored = 0;
      if (!dryRun && report.prices.length) {
        stored = await addPoints(
          report.pool,
          report.prices.map((s) => ({ t: s.t, p: s.p, source: "backfill" as const })),
        );
      }
      totalPriced += report.priced;
      totalStored += stored;

      results.push({
        symbol: token.symbol,
        token: token.token_id,
        pool: report.pool,
        pricedAgainst: quoteToken,
        historicalPointsFound: report.priced,
        newPointsStored: stored,
        eventsScanned: report.eventsScanned,
        exchangeEvents: report.exchangeEvents,
        candidateTxs: report.candidateTxs,
        unpaired: report.unpaired,
        oldest: report.oldest,
        newest: report.newest,
        notes: report.notes,
      });
    }

    return no(200, {
      ok: true,
      dryRun,
      network: NETWORK,
      tookMs: Date.now() - startedAt,
      totalHistoricalPointsFound: totalPriced,
      totalNewPointsStored: totalStored,
      results,
    });
  } catch (e) {
    return no(502, { error: "backfill failed", detail: (e as Error).message });
  }
}
