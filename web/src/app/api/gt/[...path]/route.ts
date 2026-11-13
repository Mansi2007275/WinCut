/**
 * Server-side proxy for GeckoTerminal.
 *
 * The public API allows roughly 30 requests a minute per IP, unauthenticated.
 * A trading screen polling candles, pool stats and trades would burn that in
 * seconds from a single browser, and several viewers at once would take each
 * other down. Proxying here means one cached fetch serves every viewer, and
 * the cache window is matched to how often the underlying data can actually
 * change: candles tick at their own interval, pool stats a little faster.
 *
 * Only the handful of GeckoTerminal paths the app actually uses are allowed
 * through, so this cannot be turned into an open proxy.
 */

import { NextResponse } from "next/server";

const UPSTREAM = "https://api.geckoterminal.com/api/v2";

/** Path patterns this proxy will forward, with how long to cache each. */
const ALLOWED: { pattern: RegExp; ttl: number }[] = [
  // Candles. A one-minute candle cannot change more than once a minute.
  { pattern: /^networks\/near\/pools\/[\w.:-]+\/ohlcv\/(minute|hour|day)$/, ttl: 20 },
  // Pool stats: price, 24h change, 24h volume, reserves.
  { pattern: /^networks\/near\/pools\/[\w.:-]+$/, ttl: 15 },
  // Recent swaps on a pool, for the buy/sell pressure bar.
  { pattern: /^networks\/near\/pools\/[\w.:-]+\/trades$/, ttl: 15 },
  // Several pools at once, for the landing page.
  { pattern: /^networks\/near\/pools\/multi\/[\w.:,-]+$/, ttl: 20 },
];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const route = path.join("/");
  const allowed = ALLOWED.find((a) => a.pattern.test(route));
  if (!allowed) {
    return NextResponse.json(
      { error: "that GeckoTerminal path is not proxied by WinCut", route },
      { status: 400 },
    );
  }

  const incoming = new URL(request.url);
  const query = incoming.searchParams.toString();
  const target = `${UPSTREAM}/${route}${query ? `?${query}` : ""}`;

  try {
    const upstream = await fetch(target, {
      headers: { Accept: "application/json" },
      // Next's data cache does the de-duplication across viewers.
      next: { revalidate: allowed.ttl },
    });

    const body = await upstream.text();

    if (upstream.status === 429) {
      return NextResponse.json(
        { error: "GeckoTerminal is rate limiting; the chart will retry" },
        { status: 429, headers: { "cache-control": "no-store" } },
      );
    }
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `GeckoTerminal returned ${upstream.status}`, detail: body.slice(0, 300) },
        { status: upstream.status, headers: { "cache-control": "no-store" } },
      );
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Let the browser and any CDN in front of this reuse it for the same
        // window the server cache uses, and serve stale while refetching.
        "cache-control": `public, max-age=${allowed.ttl}, stale-while-revalidate=${allowed.ttl * 3}`,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "could not reach GeckoTerminal", detail: (e as Error).message },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
