"use client";

/**
 * The panels under the field.
 *
 * Every figure here is computed in the browser from the contract's own trade
 * ring, or read from a named view call. Where a number is a comparison against
 * a venue that charges on volume rather than something WinCut measured, the
 * tile says so on its face - that distinction is the whole argument, and a
 * dashboard that blurred it would be making the argument dishonestly.
 */

import Link from "next/link";
import { useMemo } from "react";

import type { AgentDecision } from "@/lib/agent";
import { AGENT_ACCOUNT_ID, decidedByLabel, isAgent } from "@/lib/agent";
import type { TokenConfig } from "@/lib/contract";
import { useActivity, useRoute, seriesPoolFor } from "@/lib/queries";
import { isBot, isMarketMaker } from "@/lib/bots";
import type { BoardRow, CutFieldTotals, FeeSplit } from "@/lib/cutfield";
import { CONVENTIONAL_FEE_PER_SIDE } from "@/lib/cutfield";
import { ago, price as fmtPrice, shortAccount, usdCompact, usdFromNumber } from "@/lib/format";
import { explorerAccount } from "@/lib/explorer";

/* ------------------------------------------------------------------ chrome */

export function Panel({
  title,
  right,
  note,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-3 py-2">
        <h2 className="mono text-[11px] font-semibold tracking-wide text-secondary">
          {title.toUpperCase()}
        </h2>
        {right && <div className="ml-auto">{right}</div>}
      </header>
      <div className="px-3 py-3">{children}</div>
      {note && (
        <p className="mono border-t border-border px-3 py-1.5 text-[10px] leading-relaxed text-secondary">
          {note}
        </p>
      )}
    </section>
  );
}

function Tile({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "profit" | "loss" | "fee" | "credit";
}) {
  const colour = {
    neutral: "var(--color-text)",
    profit: "var(--color-profit)",
    loss: "var(--color-loss)",
    fee: "var(--color-fee)",
    credit: "var(--color-credit)",
  }[tone];
  return (
    <div className="border-l border-border px-3 py-2 first:border-l-0">
      <p className="mono text-[10px] leading-tight text-secondary">{label}</p>
      <p className="mono mt-1 text-[17px] leading-none font-semibold" style={{ color: colour }}>
        {value}
      </p>
      {sub && <p className="mono mt-1 text-[10px] leading-tight text-secondary">{sub}</p>}
    </div>
  );
}

/* --------------------------------------------------------------------- kpis */

export function KpiStrip({
  totals,
  creditHeld,
}: {
  totals: CutFieldTotals;
  creditHeld: number | undefined;
}) {
  return (
    <div className="grid grid-cols-2 divide-y divide-border rounded-card border border-border bg-surface sm:grid-cols-4 sm:divide-y-0 lg:grid-cols-7">
      <Tile
        label="volume settled"
        value={usdCompact(totals.volumeUsd)}
        sub={`${totals.trades} trades · ${totals.buys} buy / ${totals.sells} sell`}
      />
      <Tile
        label="realised by users"
        value={usdFromNumber(totals.realisedPnl, { sign: true })}
        sub={`+${usdFromNumber(totals.profitRealised)} won, -${usdFromNumber(totals.lossRealised)} lost`}
        tone={totals.realisedPnl >= 0 ? "profit" : "loss"}
      />
      <Tile
        label="fees taken"
        value={usdFromNumber(totals.feesCharged)}
        sub={totals.feesCharged === 0 ? "nothing charged yet" : "10% of profit, after credit"}
        tone="fee"
      />
      <Tile
        label="not charged on losing exits"
        value={usdFromNumber(totals.feesNotChargedOnLosses)}
        sub={`what 1% in / 1% out takes on ${totals.losingExits} losses`}
        tone="profit"
      />
      <Tile
        label="loss credit held"
        value={creditHeld === undefined ? "…" : usdFromNumber(creditHeld)}
        sub="get_loss_credit, live"
        tone="credit"
      />
      <Tile label="active traders" value={String(totals.activeTraders)} sub="distinct accounts in the ring" />
      <Tile
        label="trades today"
        value={String(totals.tradesToday)}
        sub={totals.lastAt ? `last ${ago(String(totals.lastAt * 1_000_000))}` : undefined}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- fee split */

export function FeeSplitPanel({ split, totals }: { split: FeeSplit; totals: CutFieldTotals }) {
  const parts = [
    { label: `trader ${split.traderPct}%`, value: split.toTrader, share: split.traderPct },
    { label: `referrer ${split.referrerPct}%`, value: split.toReferrer, share: split.referrerPct },
    { label: `protocol ${split.protocolPct}%`, value: split.toProtocol, share: split.protocolPct },
  ];
  const empty = split.total === 0;

  return (
    <Panel
      title="where a fee goes"
      right={
        <span className="mono text-[11px] font-semibold" style={{ color: "var(--color-fee)" }}>
          {usdFromNumber(split.total)}
        </span>
      }
      note={
        empty
          ? `No fee has been charged across ${totals.trades} settled trades. ${totals.losingExits} losing exits are free by the rule; the ${totals.winningExits} winning exits were each smaller than that account's banked credit, which is spent before any fee. The bar shows the ratio a fee would split in.`
          : "Split by the contract's own config: get_config.trader_share_pct / referrer_share_pct / protocol_share_pct. An absent trader or referrer hands their share to the protocol."
      }
    >
      <div className="flex h-2 w-full overflow-hidden rounded-pill border border-border">
        {parts.map((p) => (
          <div
            key={p.label}
            style={{
              width: `${p.share}%`,
              background: "var(--color-fee)",
              opacity: empty ? 0.18 : 0.45 + p.share / 150,
            }}
          />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {parts.map((p) => (
          <div key={p.label}>
            <p className="mono text-[10px] text-secondary">{p.label}</p>
            <p className="mono mt-0.5 text-[13px] font-semibold" style={{ color: empty ? "var(--color-secondary)" : "var(--color-fee)" }}>
              {usdFromNumber(p.value)}
            </p>
          </div>
        ))}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-2">
        <Figure label="losing exits" value={String(totals.losingExits)} />
        <Figure
          label="of those, charged a fee"
          value={String(totals.losingExitsCharged)}
          tone={totals.losingExitsCharged === 0 ? "profit" : "loss"}
        />
        <Figure label="winning exits" value={String(totals.winningExits)} />
        <Figure
          label="1%-in-1%-out would have taken"
          value={usdFromNumber(totals.feesNotChargedTotal)}
          tone="loss"
        />
      </dl>
    </Panel>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "profit" | "loss" }) {
  const colour =
    tone === "profit" ? "var(--color-profit)" : tone === "loss" ? "var(--color-loss)" : undefined;
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="mono text-[10px] text-secondary">{label}</dt>
      <dd className="mono text-[11px] font-semibold" style={{ color: colour }}>
        {value}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------- leaderboard */

export function BoardPanel({ rows }: { rows: BoardRow[] }) {
  return (
    <Panel
      title="traders"
      note="get_leaderboard, sorted here by volume. Earnings are a trader's share of fees paid by accounts that copied them."
    >
      {rows.length === 0 ? (
        <p className="mono text-[11px] text-secondary">Nobody has traded yet.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="mono text-[10px] text-secondary">
              <th className="pb-1 text-left font-normal">account</th>
              <th className="pb-1 text-right font-normal">volume</th>
              <th className="pb-1 text-right font-normal">realised</th>
              <th className="hidden pb-1 text-right font-normal sm:table-cell">w/l</th>
              <th className="pb-1 text-right font-normal">earned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.accountId} className="border-t border-border">
                <td className="py-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <a
                      href={explorerAccount(r.accountId)}
                      target="_blank"
                      rel="noreferrer"
                      className="mono truncate text-[11px] hover:underline"
                    >
                      {shortAccount(r.accountId)}
                    </a>
                    <ActorBadge accountId={r.accountId} />
                  </div>
                </td>
                <td className="mono py-1.5 text-right text-[11px]">{usdCompact(r.volume)}</td>
                <td
                  className="mono py-1.5 text-right text-[11px]"
                  style={{ color: r.realisedPnl < 0 ? "var(--color-loss)" : "var(--color-profit)" }}
                >
                  {usdFromNumber(r.realisedPnl, { sign: true })}
                </td>
                <td className="mono hidden py-1.5 text-right text-[11px] text-secondary sm:table-cell">
                  {r.wins}/{r.losses}
                </td>
                <td className="mono py-1.5 text-right text-[11px]" style={{ color: "var(--color-fee)" }}>
                  {usdFromNumber(r.earnings)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ActorBadge({ accountId }: { accountId: string }) {
  const label = isAgent(accountId)
    ? "agent"
    : isMarketMaker(accountId)
      ? "maker"
      : isBot(accountId)
        ? "bot"
        : null;
  if (!label) return null;
  return (
    <span className="mono shrink-0 rounded-pill border border-border px-1.5 py-px text-[9px] text-secondary">
      {label}
    </span>
  );
}

/* ------------------------------------------------------------ agent reasons */

export function TapePanel({
  decisions,
  detail,
  configured,
}: {
  decisions: AgentDecision[] | undefined;
  detail?: string;
  configured: boolean;
}) {
  const last = useMemo(() => (decisions ?? []).slice(0, 10), [decisions]);
  return (
    <Panel
      title="agent reasoning tape"
      right={
        AGENT_ACCOUNT_ID ? (
          <Link
            href={`/trader/${AGENT_ACCOUNT_ID}`}
            className="mono text-[10px] text-accent hover:underline"
          >
            the key it holds →
          </Link>
        ) : undefined
      }
      note="The agent's own log, newest first. A HOLD is written down exactly like a trade, because most passes are holds and a tape that only recorded action would misrepresent what it does."
    >
      {!configured ? (
        <p className="mono text-[11px] text-secondary">No agent is configured on this deployment.</p>
      ) : last.length === 0 ? (
        <p className="mono text-[11px] text-secondary">
          {detail ?? "The agent has not written a decision yet."}
        </p>
      ) : (
        <ol className="space-y-1.5">
          {last.map((d) => (
            <li key={d.t} className="border-b border-border pb-1.5 last:border-0 last:pb-0">
              <div className="flex items-center gap-2">
                <span
                  className="mono text-[10px] font-semibold"
                  style={{
                    color:
                      d.action === "BUY"
                        ? "var(--color-profit)"
                        : d.action === "SELL"
                          ? "var(--color-loss)"
                          : "var(--color-secondary)",
                  }}
                >
                  {d.action}
                </span>
                {d.symbol && <span className="mono text-[10px] text-text">{d.symbol}</span>}
                {d.sizeUsdc !== undefined && (
                  <span className="mono text-[10px] text-secondary">{usdFromNumber(d.sizeUsdc)}</span>
                )}
                <span className="mono ml-auto shrink-0 text-[9px] text-secondary">
                  {decidedByLabel(d.decidedBy)} · {ago(String(d.t * 1_000_000))}
                </span>
              </div>
              <p className="mono mt-0.5 text-[10px] leading-relaxed text-secondary">{d.reason}</p>
              {d.vetoed && (
                <p className="mono mt-0.5 text-[10px] leading-relaxed" style={{ color: "var(--color-fee)" }}>
                  risk layer: {d.vetoed.reason}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/* --------------------------------------------------------------- the strips */

/**
 * One market's strip.
 *
 * Its own component because each market needs its own pair of queries, and a
 * hook cannot be called in a loop. The parent passes tokens; each strip asks
 * the chain for its pool and Upstash for its 24h activity.
 */
function Strip({ token, mirrors }: { token: TokenConfig; mirrors?: string }) {
  const route = useRoute(token);
  const poolKey = seriesPoolFor(token);
  const activity = useActivity(token.token_id, poolKey, true);

  return (
    <div className="bg-surface px-2 py-2">
      <div className="flex items-baseline gap-2">
        <Link href={`/trade/${token.token_id}`} className="mono text-[12px] font-semibold hover:underline">
          {token.symbol}
        </Link>
        {mirrors && <span className="mono text-[9px] text-secondary">mirrors {mirrors}</span>}
        <span className="mono ml-auto text-[12px] font-semibold">
          {route.data ? fmtPrice(route.data.mid) : route.isError ? "unreadable" : "…"}
        </span>
      </div>
      <div className="mono mt-1 flex flex-wrap items-center gap-x-3 text-[10px] text-secondary">
        <span>depth {route.data ? usdCompact(route.data.liquidityUsd) : "…"}</span>
        <span>24h {activity.data ? usdCompact(activity.data.volume24hUsd) : "…"}</span>
        {activity.data?.buyPct !== undefined && activity.data?.buyPct !== null && (
          <span
            style={{
              color: activity.data.buyPct >= 50 ? "var(--color-profit)" : "var(--color-loss)",
            }}
          >
            {activity.data.buyPct.toFixed(0)}% buys
          </span>
        )}
        {activity.data && <span>{activity.data.count} fills</span>}
      </div>
    </div>
  );
}

/** Which real token each mirror tracks, for the disclosure on the strip. */
const MIRRORS: Record<string, string> = {
  MNEAR: "NEAR",
  MDRAGON: "BLACKDRAGON",
  MSHITZU: "SHITZU",
  MLONK: "LONK",
};

export function StripsPanel({ tokens }: { tokens: TokenConfig[] }) {
  return (
    <Panel
      title="markets"
      note="Price from the live Rhea pool reserves - the same read the order panel quotes from. 24h volume and buy share are computed from WinCut's own settled trades plus the market maker's swaps, because no indexer covers testnet."
    >
      <div className="grid gap-px bg-border sm:grid-cols-2">
        {tokens.map((t) => (
          <Strip key={t.token_id} token={t} mirrors={MIRRORS[t.symbol]} />
        ))}
      </div>
      {tokens.length === 0 && (
        <p className="mono text-[11px] text-secondary">No markets configured.</p>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------- solvency */

export function SolvencyPanel({
  held,
  accounted,
  shortfall,
}: {
  held: number | undefined;
  accounted: number | undefined;
  shortfall: number | undefined;
}) {
  const gap = held !== undefined && accounted !== undefined ? held - accounted : undefined;
  const ok = gap !== undefined && gap >= 0 && (shortfall ?? 0) === 0;
  return (
    <Panel
      title="solvency"
      note="ft_balance_of on the USDC token against the contract's own get_usdc_accounted. A surplus is fine; a deficit would mean the contract owes more than it holds."
      right={
        <span
          className="mono text-[10px] font-semibold"
          style={{ color: ok ? "var(--color-profit)" : "var(--color-loss)" }}
        >
          {gap === undefined ? "…" : ok ? "solvent" : "check"}
        </span>
      }
    >
      <dl className="grid gap-y-1">
        <Figure label="contract holds" value={held === undefined ? "…" : usdFromNumber(held)} />
        <Figure label="contract owes" value={accounted === undefined ? "…" : usdFromNumber(accounted)} />
        <Figure
          label="surplus"
          value={gap === undefined ? "…" : usdFromNumber(gap)}
          tone={gap !== undefined && gap < 0 ? "loss" : "profit"}
        />
        <Figure
          label="recorded shortfall"
          value={shortfall === undefined ? "…" : usdFromNumber(shortfall)}
          tone={(shortfall ?? 0) > 0 ? "loss" : "profit"}
        />
      </dl>
    </Panel>
  );
}

export { CONVENTIONAL_FEE_PER_SIDE };
