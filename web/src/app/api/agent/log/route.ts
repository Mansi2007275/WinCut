/**
 * Serves the agent's decision log.
 *
 * Read-only, and the agent is the only writer - the loop in `agent/` writes
 * here, the browser only reads. The route takes no account id from the query
 * string: it serves the log of the one configured agent, because letting a
 * caller name the key would let any string be presented on the site as "the
 * agent's reasoning".
 *
 * When the log is empty the response says why, so the page can distinguish "it
 * has not decided anything yet" from "nothing is configured" instead of showing
 * the same blank panel for both.
 */

import { NextResponse } from "next/server";

import { AGENT_ACCOUNT_ID, type AgentDecision } from "@/lib/agent";

export const dynamic = "force-dynamic";

const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const configured = Boolean(URL_ && TOKEN && AGENT_ACCOUNT_ID);

const MAX_LIMIT = 200;

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 40) || 40),
  );

  if (!AGENT_ACCOUNT_ID) {
    return json({
      agent: null,
      configured: false,
      decisions: [],
      detail:
        "No agent is configured. Set NEXT_PUBLIC_AGENT_ACCOUNT_ID to the agent's account id once it is running.",
    });
  }

  if (!configured) {
    return json({
      agent: AGENT_ACCOUNT_ID,
      configured: false,
      decisions: [],
      detail:
        "The agent's log lives in Upstash, which is not configured here. Its trades are still on chain and still shown; only the reasoning behind them is unavailable.",
    });
  }

  try {
    const res = await fetch(`${URL_}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify([
        [
          "ZRANGE",
          `wincut:agent:${AGENT_ACCOUNT_ID}:log`,
          "+inf",
          "-inf",
          "BYSCORE",
          "REV",
          "LIMIT",
          "0",
          String(limit),
        ],
      ]),
      cache: "no-store",
    });

    if (!res.ok) {
      return json(
        { agent: AGENT_ACCOUNT_ID, configured: true, decisions: [], detail: `Upstash responded ${res.status}.` },
        502,
      );
    }

    const body = (await res.json()) as { result?: unknown; error?: string }[];
    if (body[0]?.error) {
      return json(
        { agent: AGENT_ACCOUNT_ID, configured: true, decisions: [], detail: body[0].error },
        502,
      );
    }

    const raw = (body[0]?.result as string[] | null) ?? [];
    const decisions: AgentDecision[] = [];
    for (const line of raw) {
      try {
        decisions.push(JSON.parse(line) as AgentDecision);
      } catch {
        // A malformed entry is skipped rather than taking the whole log down.
      }
    }

    return json({
      agent: AGENT_ACCOUNT_ID,
      configured: true,
      decisions,
      detail: decisions.length
        ? undefined
        : "The agent has not written a decision yet. The first one appears within five minutes of it starting.",
    });
  } catch (e) {
    return json(
      {
        agent: AGENT_ACCOUNT_ID,
        configured: true,
        decisions: [],
        detail: `Could not read the log: ${(e as Error).message}`,
      },
      502,
    );
  }
}
