/**
 * Server-side proxy for the NEAR Intents 1Click API.
 *
 * Three reasons it does not go straight from the browser:
 *
 *  - 1Click takes an optional `X-API-Key`, and a key belongs on the server.
 *    It works without one today, which is why the demo runs unauthenticated,
 *    but the moment a key is added the browser must not be holding it.
 *  - a quote request carries the user's own NEAR account and refund address,
 *    and keeping that in a same-origin request avoids a third-party CORS
 *    preflight carrying it around.
 *  - only the three paths this app uses are forwarded, so it cannot become an
 *    open proxy.
 *
 * Nothing here is cached: a quote reserves a deposit address and a status is
 * the whole point of polling.
 */

import { NextResponse } from "next/server";

const UPSTREAM = "https://1click.chaindefuser.com/v0";

const ALLOWED: { pattern: RegExp; methods: string[] }[] = [
  { pattern: /^tokens$/, methods: ["GET"] },
  { pattern: /^quote$/, methods: ["POST"] },
  { pattern: /^status$/, methods: ["GET"] },
];

function headers() {
  const key = process.env.ONECLICK_API_KEY;
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(key ? { "X-API-Key": key } : {}),
  };
}

async function forward(request: Request, path: string[], method: "GET" | "POST") {
  const route = path.join("/");
  const allowed = ALLOWED.find((a) => a.pattern.test(route) && a.methods.includes(method));
  if (!allowed) {
    return NextResponse.json(
      { error: "that 1Click path is not proxied by WinCut", route, method },
      { status: 400 },
    );
  }

  const incoming = new URL(request.url);
  const query = incoming.searchParams.toString();
  const target = `${UPSTREAM}/${route}${query ? `?${query}` : ""}`;

  try {
    const upstream = await fetch(target, {
      method,
      headers: headers(),
      body: method === "POST" ? await request.text() : undefined,
      cache: "no-store",
    });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "could not reach NEAR Intents", detail: (e as Error).message },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await ctx.params).path, "GET");
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await ctx.params).path, "POST");
}
