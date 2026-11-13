"use client";

/**
 * "Why this fee", worked through on the numbers the user is actually trading.
 *
 * Not a static illustration: it takes the amount in the order panel and runs
 * both outcomes - the same trade up 20% and down 20% - so the asymmetry at the
 * heart of WinCut is visible on the user's own size. The loss case is the point
 * of the product, so it gets the same prominence as the win.
 *
 * The maths is the contract's own `settle_sell`, re-derived here only because
 * asking the chain for a hypothetical on every keystroke would be wasteful.
 * `quote_sell_fee` is what the order panel quotes from; this box explains it.
 */

import { useMemo } from "react";
import { usd, usdFromNumber } from "@/lib/format";
import { USDC_DECIMALS } from "@/lib/near";
import { Card } from "./ui";

const FEE_PCT = 10;

type Outcome = {
  label: string;
  proceeds: bigint;
  pnl: bigint;
  creditUsed: bigint;
  fee: bigint;
  keeps: bigint;
  creditAfter: bigint;
};

function settle(basis: bigint, proceeds: bigint, credit: bigint): Omit<Outcome, "label"> {
  if (proceeds < basis) {
    const loss = basis - proceeds;
    return {
      proceeds,
      pnl: -loss,
      creditUsed: 0n,
      fee: 0n,
      keeps: proceeds,
      creditAfter: credit + loss,
    };
  }
  const profit = proceeds - basis;
  const creditUsed = credit < profit ? credit : profit;
  const taxable = profit - creditUsed;
  const fee = (taxable * BigInt(FEE_PCT)) / 100n;
  return {
    proceeds,
    pnl: profit,
    creditUsed,
    fee,
    keeps: proceeds - fee,
    creditAfter: credit - creditUsed,
  };
}

export function FeeExplainer({
  /** The amount being traded, in raw USDC. Falls back to $100 when empty. */
  basisUsdc,
  lossCredit = 0n,
  hasTrader,
  hasReferrer,
}: {
  basisUsdc: bigint;
  lossCredit?: bigint;
  hasTrader: boolean;
  hasReferrer: boolean;
}) {
  const basis = basisUsdc > 0n ? basisUsdc : BigInt(100 * 10 ** USDC_DECIMALS);

  const outcomes = useMemo<Outcome[]>(
    () => [
      { label: "up 20%", ...settle(basis, (basis * 120n) / 100n, lossCredit) },
      { label: "down 20%", ...settle(basis, (basis * 80n) / 100n, lossCredit) },
    ],
    [basis, lossCredit],
  );

  const [win, lose] = outcomes;
  const splitOf = (fee: bigint) => ({
    trader: hasTrader ? (fee * 50n) / 100n : 0n,
    referrer: hasReferrer ? (fee * 20n) / 100n : 0n,
    protocol:
      fee - (hasTrader ? (fee * 50n) / 100n : 0n) - (hasReferrer ? (fee * 20n) / 100n : 0n),
  });
  const split = splitOf(win.fee);

  return (
    <Card className="p-3">
      <p className="text-xs font-semibold">Why this fee</p>
      <p className="mt-1 text-[11px] leading-relaxed text-secondary">
        On {usd(basis)}, both ways:
      </p>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Outcome outcome={win} tone="profit" lossCredit={lossCredit} />
        <Outcome outcome={lose} tone="loss" lossCredit={lossCredit} />
      </div>

      {win.fee > 0n && (
        <div className="mt-2.5 border-t border-border pt-2">
          <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">
            Where the {usd(win.fee)} goes
          </p>
          <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-pill bg-elevated">
            <Bar value={split.trader} total={win.fee} className="bg-accent" />
            <Bar value={split.referrer} total={win.fee} className="bg-profit" />
            <Bar value={split.protocol} total={win.fee} className="bg-secondary" />
          </div>
          <ul className="mt-1.5 space-y-0.5 text-[10px] text-secondary">
            <Share
              colour="bg-accent"
              label={hasTrader ? "copied trader" : "copied trader — nobody selected"}
              value={split.trader}
              pct={hasTrader ? "50%" : "0%"}
            />
            <Share
              colour="bg-profit"
              label={hasReferrer ? "your referrer" : "referrer — none on this link"}
              value={split.referrer}
              pct={hasReferrer ? "20%" : "0%"}
            />
            <Share
              colour="bg-secondary"
              label={
                hasTrader && hasReferrer
                  ? "WinCut protocol"
                  : "WinCut protocol — takes the unclaimed shares"
              }
              value={split.protocol}
              pct={`${100 - (hasTrader ? 50 : 0) - (hasReferrer ? 20 : 0)}%`}
            />
          </ul>
        </div>
      )}

      <p className="mt-2.5 border-t border-border pt-2 text-[10px] leading-relaxed text-secondary">
        Rhea&apos;s pool fee and NEAR gas still apply to every trade either way. Those go to the
        liquidity providers and the network, not to WinCut.
      </p>
    </Card>
  );
}

function Outcome({
  outcome,
  tone,
  lossCredit,
}: {
  outcome: Outcome;
  tone: "profit" | "loss";
  lossCredit: bigint;
}) {
  const win = tone === "profit";
  return (
    <div
      className={`rounded-btn border p-2 ${
        win ? "border-profit/30 bg-profit-dim" : "border-loss/30 bg-loss-dim"
      }`}
    >
      <p className={`text-[10px] font-semibold tracking-wide uppercase ${win ? "text-profit" : "text-loss"}`}>
        {outcome.label}
      </p>
      <dl className="mt-1.5 space-y-1 text-[11px]">
        <Line label="out" value={usd(outcome.proceeds)} />
        <Line
          label={win ? "profit" : "loss"}
          value={usdFromNumber(Number(outcome.pnl) / 10 ** USDC_DECIMALS, { sign: true })}
          className={win ? "text-profit" : "text-loss"}
        />
        {outcome.creditUsed > 0n && (
          <Line label="credit used" value={`−${usd(outcome.creditUsed)}`} className="text-accent" />
        )}
        <Line
          label="WinCut fee"
          value={outcome.fee === 0n ? "$0.00" : usd(outcome.fee)}
          className={outcome.fee === 0n ? "font-semibold text-profit" : "font-semibold"}
        />
        <Line label="you keep" value={usd(outcome.keeps)} className="font-semibold" />
        {!win && (
          <Line
            label="credit banked"
            value={usd(outcome.creditAfter - lossCredit)}
            className="text-accent"
          />
        )}
      </dl>
      {!win && (
        <p className="mt-1.5 text-[10px] leading-snug text-secondary">
          No fee, and that {usd(outcome.creditAfter - lossCredit)} shelters your next win.
        </p>
      )}
    </div>
  );
}

function Line({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-secondary">{label}</dt>
      <dd className={`num ${className}`}>{value}</dd>
    </div>
  );
}

function Bar({
  value,
  total,
  className,
}: {
  value: bigint;
  total: bigint;
  className: string;
}) {
  if (total === 0n || value === 0n) return null;
  return <div className={className} style={{ width: `${(Number(value) / Number(total)) * 100}%` }} />;
}

function Share({
  colour,
  label,
  value,
  pct,
}: {
  colour: string;
  label: string;
  value: bigint;
  pct: string;
}) {
  return (
    <li className="flex items-baseline justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-pill ${colour}`} />
        <span className="truncate">{label}</span>
      </span>
      <span className="num shrink-0">
        {pct} · {usd(value)}
      </span>
    </li>
  );
}
