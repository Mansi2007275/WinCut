/**
 * The part that has an opinion.
 *
 * Two deciders live here. The first asks a model over the OpenAI-compatible
 * chat completions API that NEAR AI Cloud serves. The second is arithmetic:
 * momentum against the window mean, with an exit rule. The second is not a
 * stub - it is what runs whenever there is no API key, whenever the request
 * fails, and whenever the model answers something that is not usable JSON. An
 * agent whose only decider is a network call is an agent that stops trading
 * when a vendor has an outage.
 *
 * Neither decider is trusted with the limits. Both return a proposal, and
 * `risk.ts` decides whether it becomes a transaction.
 */

import { FALLBACK, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, RISK } from "./config.js";
import type { MarketView } from "./market.js";
import type { PositionState, Proposal } from "./risk.js";

export type Brain = "llm" | "fallback";
export type Thought = { proposal: Proposal; decidedBy: Brain; raw?: string };

const num = (v: number | undefined, digits = 4): string =>
  v === undefined ? "unknown" : v.toFixed(digits);

/**
 * The prompt states the limits so a proposal has a chance of being accepted,
 * but it says plainly that applying them is not the model's job. That is the
 * honest description of the system; misleading the model about who holds the
 * brake would only make its reasoning worse.
 */
function buildPrompt(
  markets: MarketView[],
  states: PositionState[],
  balanceUsdc: number,
  tradesLast24h: number,
) {
  const marketLines = markets.map(
    (m) =>
      `- ${m.token.symbol} (${m.token.token_id}): price ${num(m.mid, 6)}, pool depth ${num(m.liquidity, 2)} tUSDC, ` +
      `window change ${num(m.changePct, 2)}%, momentum ${num(m.momentumPct, 2)}%, ` +
      `${m.candles.length} candle(s)` +
      (m.notes.length ? ` [${m.notes.join("; ")}]` : ""),
  );

  const positionLines = states.length
    ? states.map(
        (s) =>
          `- ${s.position.symbol}: ${num(Number(s.position.amount) / 10 ** s.position.decimals, 6)} held, ` +
          `entry ${num(s.entry, 6)}, now ${num(s.mid, 6)}, unrealised ${num(s.unrealisedPct, 2)}%`,
      )
    : ["- none"];

  const system = [
    "You are the trading brain of WinCut, an on-chain trader on NEAR.",
    "You see only real data read from the chain. If a field says unknown, it is genuinely unavailable - do not guess what it might be, and prefer HOLD when the inputs are too thin to read a trend.",
    "Answer with one JSON object and nothing else:",
    '{"action":"BUY"|"SELL"|"HOLD","token_id":string|null,"size_usdc":number|null,"sell_fraction":number|null,"reason":string}',
    "reason is one or two sentences a human will read on a public page. Name the numbers you acted on.",
    "",
    "The limits below are enforced in code after you answer. Applying them is not your job. A proposal that breaks a limit on size is trimmed to fit; one that breaks any other limit is refused and logged as a refusal, which reads worse than a plain HOLD:",
    `- a buy may spend at most ${RISK.maxShareOfBalancePerTrade * 100}% of the balance`,
    `- at most ${RISK.maxOpenPositions} positions open at once`,
    `- at most ${RISK.maxTradesPerDay} trades per 24 hours`,
    `- a position past ${RISK.stopLossPct}% or +${RISK.takeProfitPct}% is closed automatically before you are asked`,
    `- no buy smaller than ${RISK.minTradeUsdc} tUSDC`,
    `- a buy may also take at most ${RISK.maxShareOfPoolDepth * 100}% of the market's pool depth, which is shown per market below`,
    "An oversized buy is trimmed to whichever of those is lowest rather than refused, so it still trades - just smaller than you asked, and the log will say the size was ours. Sizing to them yourself is still better: on a thin pool your own trade is most of the price move you would otherwise be reacting to.",
  ].join("\n");

  const user = [
    `Balance available to trade: ${num(balanceUsdc, 2)} tUSDC`,
    `Trades in the last 24 hours: ${tradesLast24h} of ${RISK.maxTradesPerDay}`,
    "",
    "Open positions:",
    ...positionLines,
    "",
    "Markets:",
    ...marketLines,
    "",
    "Decide one action.",
  ].join("\n");

  return { system, user };
}

function parseProposal(text: string): Proposal | null {
  // Models wrap JSON in prose or fences often enough that finding the object is
  // part of parsing it, not a workaround.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const action = String(parsed.action ?? "").toUpperCase();
  if (action !== "BUY" && action !== "SELL" && action !== "HOLD") return null;
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "no reason given";
  const tokenId = typeof parsed.token_id === "string" && parsed.token_id ? parsed.token_id : undefined;
  const size =
    typeof parsed.size_usdc === "number" && Number.isFinite(parsed.size_usdc) ? parsed.size_usdc : undefined;
  const fraction =
    typeof parsed.sell_fraction === "number" && Number.isFinite(parsed.sell_fraction)
      ? parsed.sell_fraction
      : undefined;
  return { action, tokenId, sizeUsdc: size, sellFraction: fraction, reason };
}

async function askModel(
  markets: MarketView[],
  states: PositionState[],
  balanceUsdc: number,
  tradesLast24h: number,
): Promise<{ proposal: Proposal; raw: string } | { error: string }> {
  const { system, user } = buildPrompt(markets, states, balanceUsdc, tradesLast24h);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(`${LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${LLM_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string } | string;
    };
    if (!res.ok) {
      const detail = typeof body.error === "string" ? body.error : body.error?.message;
      return { error: `${LLM_MODEL} responded ${res.status}${detail ? `: ${detail}` : ""}` };
    }
    const raw = body.choices?.[0]?.message?.content ?? "";
    const proposal = parseProposal(raw);
    if (!proposal) return { error: `${LLM_MODEL} did not return a usable decision` };
    return { proposal, raw };
  } catch (e) {
    const err = e as Error;
    return { error: err.name === "AbortError" ? `${LLM_MODEL} timed out` : `${LLM_MODEL}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Momentum with an exit. Buys the strongest market whose momentum clears a
 * threshold, trims a position whose momentum has turned, and otherwise holds.
 * Deliberately dull: its job is to be defensible without a model, not to win.
 */
export function fallbackDecision(
  markets: MarketView[],
  states: PositionState[],
  balanceUsdc: number,
): Proposal {
  const ENTER_PCT = FALLBACK.enterPct;
  const EXIT_PCT = FALLBACK.exitPct;

  const held = new Map(states.map((s) => [s.position.token_id, s]));

  // Exit first: a position whose market has turned down is trimmed before any
  // new idea gets considered.
  for (const s of states) {
    const m = markets.find((x) => x.token.token_id === s.position.token_id);
    if (m?.momentumPct !== undefined && m.momentumPct <= EXIT_PCT) {
      return {
        action: "SELL",
        tokenId: s.position.token_id,
        sellFraction: 0.5,
        reason:
          `Momentum fallback: ${s.position.symbol} momentum is ${m.momentumPct.toFixed(2)}%, below the ` +
          `${EXIT_PCT}% exit. Trimming half while the position is ${s.unrealisedPct.toFixed(2)}%.`,
      };
    }
  }

  const candidates = markets
    .filter((m) => m.momentumPct !== undefined && m.momentumPct >= ENTER_PCT && m.liquidity > 0)
    .sort((a, b) => (b.momentumPct ?? 0) - (a.momentumPct ?? 0));

  const best = candidates.find((m) => held.has(m.token.token_id) || held.size < RISK.maxOpenPositions);
  if (best) {
    const size = Math.max(RISK.minTradeUsdc, balanceUsdc * RISK.maxShareOfBalancePerTrade);
    return {
      action: "BUY",
      tokenId: best.token.token_id,
      sizeUsdc: Number(size.toFixed(2)),
      reason:
        `Momentum fallback: ${best.token.symbol} momentum is +${(best.momentumPct ?? 0).toFixed(2)}%, the strongest ` +
        `above the ${ENTER_PCT}% entry, with ${best.liquidity.toFixed(0)} tUSDC of depth.`,
    };
  }

  const readable = markets.filter((m) => m.momentumPct !== undefined).length;
  return {
    action: "HOLD",
    reason:
      readable === 0
        ? "Momentum fallback: no market has enough candles yet to read a trend, so there is nothing to act on."
        : `Momentum fallback: none of the ${readable} readable markets cleared the ${ENTER_PCT}% entry threshold.`,
  };
}

export async function decide(
  markets: MarketView[],
  states: PositionState[],
  balanceUsdc: number,
  tradesLast24h: number,
): Promise<Thought & { llmError?: string }> {
  if (!LLM_API_KEY) {
    return { proposal: fallbackDecision(markets, states, balanceUsdc), decidedBy: "fallback" };
  }
  const answer = await askModel(markets, states, balanceUsdc, tradesLast24h);
  if ("error" in answer) {
    const proposal = fallbackDecision(markets, states, balanceUsdc);
    return {
      proposal: { ...proposal, reason: `${proposal.reason} (model unavailable: ${answer.error})` },
      decidedBy: "fallback",
      llmError: answer.error,
    };
  }
  return { proposal: answer.proposal, decidedBy: "llm", raw: answer.raw };
}
