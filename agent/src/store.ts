/**
 * The decision log.
 *
 * Every pass writes one entry, including the passes where nothing happens. A
 * log that only records trades flatters the agent: it hides the hours it sat
 * still and makes a handful of lucky entries look like a strategy. HOLDs are
 * the majority of what an honest trader does, so they are the majority of what
 * is stored here.
 *
 * Upstash is the backing store because the web app already uses it for the
 * price series, so the agent page reads from the same place. Without Upstash
 * credentials the agent still runs and still prints its reasoning - it just
 * cannot remember across restarts, and says so.
 */

import { UPSTASH_TOKEN, UPSTASH_URL, AGENT_ACCOUNT_ID } from "./config.js";
import type { Action } from "./risk.js";

export const storeConfigured = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

const KEY = `wincut:agent:${AGENT_ACCOUNT_ID}:log`;
const MAX_ENTRIES = 2000;

export type DecisionInputs = {
  balanceUsdc: number;
  openPositions: { symbol: string; amount: number; entry: number; mid: number; pnlPct: number }[];
  markets: {
    symbol: string;
    tokenId: string;
    mid: number;
    liquidity: number;
    changePct?: number;
    momentumPct?: number;
    candles: number;
    notes: string[];
  }[];
  tradesLast24h: number;
};

export type DecisionEntry = {
  /** Milliseconds since the epoch. */
  t: number;
  action: Action;
  tokenId?: string;
  symbol?: string;
  sizeUsdc?: number;
  sellFraction?: number;
  /** Why, in the agent's own words. */
  reason: string;
  /** Who decided: the model, the deterministic fallback, or a hard rule. */
  decidedBy: "llm" | "fallback" | "risk" | "forced-exit";
  /** Set when the risk layer overruled a proposal. */
  vetoed?: { action: Action; reason: string };
  inputs: DecisionInputs;
  txHash?: string;
  /** Set when a signed trade failed on chain. */
  error?: string;
  dryRun: boolean;
};

async function upstash(command: unknown[]): Promise<unknown> {
  const res = await fetch(UPSTASH_URL!, {
    method: "POST",
    headers: { authorization: `Bearer ${UPSTASH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `upstash ${res.status}`);
  return body.result;
}

/** Kept so a run with no credentials can still show its own history. */
const memory: DecisionEntry[] = [];

export async function record(entry: DecisionEntry): Promise<void> {
  memory.push(entry);
  if (memory.length > MAX_ENTRIES) memory.shift();
  if (!storeConfigured) return;
  // A sorted set keyed by timestamp: append-only, read back in order, and
  // trimmed from the front so the log cannot grow without bound.
  await upstash(["ZADD", KEY, String(entry.t), JSON.stringify(entry)]);
  await upstash(["ZREMRANGEBYRANK", KEY, "0", String(-MAX_ENTRIES - 1)]);
}

export async function readLog(limit = 50): Promise<DecisionEntry[]> {
  if (!storeConfigured) return memory.slice(-limit).reverse();
  const raw = (await upstash(["ZRANGE", KEY, "+inf", "-inf", "BYSCORE", "REV", "LIMIT", "0", String(limit)])) as
    | string[]
    | null;
  if (!raw) return [];
  const out: DecisionEntry[] = [];
  for (const line of raw) {
    try {
      out.push(JSON.parse(line) as DecisionEntry);
    } catch {
      // A malformed entry is skipped rather than taking the whole log down.
    }
  }
  return out;
}

export async function countTradesSince(sinceMs: number): Promise<number> {
  const entries = storeConfigured ? await readLog(MAX_ENTRIES) : memory;
  return entries.filter((e) => e.t >= sinceMs && e.action !== "HOLD" && e.txHash).length;
}
