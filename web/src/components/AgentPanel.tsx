"use client";

/**
 * The agent's reasoning, shown as it was recorded.
 *
 * Two decisions about honesty shape this panel.
 *
 * The HOLDs stay. An agent that has not traded yet has still been deciding,
 * and a log filtered down to its trades would make a handful of entries look
 * like a track record. Holding is most of what an honest trader does, so it is
 * most of what appears here.
 *
 * A refusal is labelled as a refusal. When the risk layer overrules a proposal
 * the entry shows both: the HOLD that happened and the trade that was stopped,
 * with the limit that stopped it. That is the part a viewer most needs in order
 * to judge whether the limits are real.
 */

import { Badge, Card, Empty, SectionHeading, SkeletonRows } from "@/components/ui";
import {
  KEY_LIMITS, KEY_LIMITS_DETAIL, decidedByLabel, decidedByTone,
  type AgentDecision, type AgentLog,
} from "@/lib/agent";
import { explorerTx } from "@/lib/explorer";
import { QUOTE_LABEL } from "@/lib/near";

const ago = (ms: number): string => {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const pct = (v: number | undefined): string =>
  v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function ActionBadge({ decision }: { decision: AgentDecision }) {
  if (decision.action === "BUY") return <Badge tone="profit">buy</Badge>;
  if (decision.action === "SELL") return <Badge tone="loss">sell</Badge>;
  return <Badge tone="neutral">hold</Badge>;
}

/** The statement about what the key can do, with how to check it. */
export function AgentKeyNote() {
  return (
    <Card className="border-accent/30 p-3">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-px text-accent">
          🔑
        </span>
        <div className="min-w-0">
          <p className="text-[12px] leading-relaxed font-semibold text-text">{KEY_LIMITS}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-secondary">{KEY_LIMITS_DETAIL}</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">
            You do not have to take that on trust - the permission is on the key itself, so the
            chain will confirm it:{" "}
            <code className="rounded border border-border bg-bg px-1 py-0.5 text-[10px] break-all">
              near account list-keys {process.env.NEXT_PUBLIC_AGENT_ACCOUNT_ID ?? "<agent>"}{" "}
              network-config testnet now
            </code>
          </p>
        </div>
      </div>
    </Card>
  );
}

function DecisionRow({ decision }: { decision: AgentDecision }) {
  const held = decision.inputs?.openPositions ?? [];
  const markets = decision.inputs?.markets ?? [];
  const readable = markets.filter((m) => m.momentumPct !== undefined);

  return (
    <li className="border-b border-border py-2.5 last:border-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <ActionBadge decision={decision} />
        {decision.symbol && <span className="num text-[12px] font-semibold">{decision.symbol}</span>}
        {decision.action === "BUY" && decision.sizeUsdc !== undefined && (
          <span className="num text-[11px] text-secondary">
            {decision.sizeUsdc.toFixed(2)} {QUOTE_LABEL}
          </span>
        )}
        {decision.action === "SELL" && decision.sellFraction !== undefined && (
          <span className="num text-[11px] text-secondary">
            {Math.round(decision.sellFraction * 100)}% of the position
          </span>
        )}
        <Badge tone={decidedByTone(decision.decidedBy)}>{decidedByLabel(decision.decidedBy)}</Badge>
        {decision.dryRun && <Badge tone="neutral">dry run</Badge>}
        <span className="num ml-auto shrink-0 text-[10px] text-secondary">{ago(decision.t)}</span>
      </div>

      <p className="mt-1.5 text-[12px] leading-relaxed text-text">{decision.reason}</p>

      {decision.vetoed && (
        <p className="mt-1 border-l-2 border-loss/40 pl-2 text-[11px] leading-relaxed text-secondary">
          <span className="font-semibold text-loss">stopped by a limit:</span> it proposed a{" "}
          {decision.vetoed.action.toLowerCase()} - &ldquo;{decision.vetoed.reason}&rdquo;
        </p>
      )}

      {decision.error && (
        <p className="mt-1 text-[11px] leading-relaxed text-loss">
          the transaction failed: {decision.error}
        </p>
      )}

      {decision.txHash && (
        <a
          href={explorerTx(decision.txHash)}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-[11px] text-accent underline-offset-2 hover:underline"
        >
          transaction ↗
        </a>
      )}

      <p className="num mt-1 text-[10px] leading-relaxed text-secondary">
        saw {decision.inputs?.balanceUsdc?.toFixed(2) ?? "?"} {QUOTE_LABEL} ·{" "}
        {held.length ? held.map((p) => `${p.symbol} ${pct(p.pnlPct)}`).join(", ") : "no positions"} ·{" "}
        {readable.length} of {markets.length} market{markets.length === 1 ? "" : "s"} with a readable
        trend · {decision.inputs?.tradesLast24h ?? 0} trade
        {decision.inputs?.tradesLast24h === 1 ? "" : "s"} in 24h
      </p>
    </li>
  );
}

export function AgentReasoning({
  log,
  isPending,
  error,
}: {
  log: AgentLog | undefined;
  isPending: boolean;
  error?: Error | null;
}) {
  const decisions = log?.decisions ?? [];
  const traded = decisions.filter((d) => d.action !== "HOLD" && d.txHash).length;

  return (
    <Card className="p-3">
      <SectionHeading
        right={
          decisions.length ? (
            <span className="num text-[10px] text-secondary">
              {decisions.length} decision{decisions.length === 1 ? "" : "s"} · {traded} traded
            </span>
          ) : undefined
        }
      >
        Why it did that
      </SectionHeading>

      <p className="mt-1 text-[11px] leading-relaxed text-secondary">
        Every pass the agent makes is written down, including the ones where it decided to do
        nothing - which is most of them. Nothing here is filtered to make the record look better.
      </p>

      {isPending ? (
        <div className="mt-2">
          <SkeletonRows rows={3} height="h-16" />
        </div>
      ) : error ? (
        <p className="mt-2 text-[11px] leading-relaxed text-loss">
          The log could not be read: {error.message}
        </p>
      ) : !decisions.length ? (
        <div className="mt-2">
          <Empty
            title={log?.configured === false ? "No reasoning to show" : "It has not decided anything yet"}
            hint={log?.detail}
          />
        </div>
      ) : (
        <ul className="mt-1 flex flex-col">
          {decisions.map((d) => (
            <DecisionRow key={`${d.t}-${d.action}-${d.tokenId ?? "none"}`} decision={d} />
          ))}
        </ul>
      )}

      {traded === 0 && decisions.length > 0 && (
        <p className="mt-2 border-t border-border pt-2 text-[11px] leading-relaxed text-secondary">
          It has not opened a position yet. The entries above are real decisions taken from real
          chain data - the agent holds when the data does not support a trade, and on testnet the
          price series takes a while to grow enough history to read a trend from.
        </p>
      )}
    </Card>
  );
}
