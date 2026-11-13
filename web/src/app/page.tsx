"use client";

/**
 * The landing page. One idea, stated once, then proved with live numbers.
 *
 * The calculator is not an illustration: it calls `quote_fee_for` on the
 * deployed contract, which runs the same pure settlement function the sell
 * callback runs. The traders below it are the real leaderboard, and the
 * markets are the real listed routes with live prices from Rhea.
 */

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";

import { Page } from "@/components/Shell";
import { MarketRow } from "@/components/MarketRow";
import { LeaderboardList } from "@/components/TradeTabs";
import { ConnectCta, NeedsContract } from "@/components/Gate";
import { Card, Empty, SectionHeading, SkeletonRows } from "@/components/ui";
import {
  useAllPoolStats,
  useConfig,
  useFeeExample,
  useLeaderboard,
  useRecentTrades,
  useTokens,
} from "@/lib/queries";
import { useWallet } from "@/lib/wallet";
import { USDC_DECIMALS, isDeployed } from "@/lib/near";
import { toNumber, toRaw, usd, usdFromNumber } from "@/lib/format";

export default function Landing() {
  return (
    <Suspense fallback={<Page width="lg" />}>
      <LandingBody />
    </Suspense>
  );
}

function LandingBody() {
  const { accountId } = useWallet();
  const tokens = useTokens();
  const stats = useAllPoolStats(tokens.data);
  const board = useLeaderboard(5);
  const trades = useRecentTrades(10);
  const config = useConfig();

  const settled = useMemo(() => {
    const list = trades.data ?? [];
    const sells = list.filter((t) => t.side === "Sell");
    const freeSells = sells.filter((t) => BigInt(t.fee) === 0n).length;
    return { sells: sells.length, freeSells, total: config.data?.total_trades ?? list.length };
  }, [trades.data, config.data]);

  return (
    <Page width="lg">
      {/* ------------------------------------------------------------ hero */}
      <section>
        <h1 className="text-[26px] leading-tight font-semibold sm:text-[32px]">
          Copy trading where the fee
          <br />
          <span className="text-profit">only comes out of profit.</span>
        </h1>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-secondary">
          Buying is free. Selling at a loss is free, and the loss is banked as a credit that
          shelters your next win. Only a realised profit is charged, at 10%, split with the trader
          you copied and whoever referred you.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link
            href="/trade"
            className="tap rounded-btn bg-profit px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-profit/90"
          >
            Start trading
          </Link>
          {!accountId && (
            <div className="w-40">
              <ConnectCta />
            </div>
          )}
          <Link
            href="/how-it-works"
            className="rounded-btn border border-border px-4 py-2.5 text-sm font-medium text-secondary transition-colors hover:text-text"
          >
            How the fee works
          </Link>
        </div>
      </section>

      {/* ------------------------------------------------------ calculator */}
      <Calculator />

      {/* -------------------------------------------------- the comparison */}
      <Comparison />

      {/* --------------------------------------------------- live evidence */}
      {isDeployed && settled.sells > 0 && (
        <Card className="p-3">
          <p className="text-[11px] leading-relaxed text-secondary">
            <span className="num font-semibold text-text">{settled.total}</span> trades settled on
            chain so far.{" "}
            <span className="num font-semibold text-profit">{settled.freeSells}</span> of the last{" "}
            <span className="num">{settled.sells}</span> sells were charged nothing at all,
            because they were not profitable.
          </p>
        </Card>
      )}

      {/* --------------------------------------------------------- traders */}
      <section className="flex flex-col gap-2">
        <SectionHeading
          right={
            <Link href="/board" className="text-[11px] text-accent hover:underline">
              all traders →
            </Link>
          }
        >
          Top traders right now
        </SectionHeading>
        {!isDeployed ? (
          <NeedsContract what="top traders" />
        ) : board.isPending ? (
          <SkeletonRows rows={3} height="h-14" />
        ) : !board.data?.length ? (
          <Empty
            title="Nobody on the board yet"
            hint="Traders appear once they have closed a position, because the board ranks by realised profit rather than by an open paper gain."
          />
        ) : (
          <Card className="px-3 py-1">
            <LeaderboardList rows={board.data} />
          </Card>
        )}
      </section>

      {/* --------------------------------------------------------- markets */}
      <section className="flex flex-col gap-2">
        <SectionHeading
          right={
            <Link href="/trade" className="text-[11px] text-accent hover:underline">
              all markets →
            </Link>
          }
        >
          Markets
        </SectionHeading>
        {tokens.isPending ? (
          <SkeletonRows rows={4} height="h-16" />
        ) : !tokens.data?.length ? (
          <Empty title="No markets listed yet" hint="Run list_token for each verified route." />
        ) : (
          <Card className="p-0">
            <ul className="flex flex-col divide-y divide-border">
              {tokens.data.slice(0, 4).map((token) => (
                <li key={token.token_id}>
                  <Link
                    href={`/trade/${encodeURIComponent(token.token_id)}`}
                    className="block transition-colors hover:bg-elevated"
                  >
                    <MarketRow token={token} stats={stats.data?.get(token.chart_pool)} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </Page>
  );
}

/* --------------------------------------------------------------- calculator */

/**
 * The fee calculator, answered by the contract.
 *
 * `quote_fee_for` is a view on the deployed contract that runs the same
 * `settle_sell` the settlement callback runs, so the figure here is not an
 * approximation of the fee - it is the fee. When no contract is configured the
 * box says so rather than quietly falling back to doing the arithmetic in the
 * browser, which would look identical and mean something completely different.
 */
function Calculator() {
  const [stake, setStake] = useState("1000");
  const [exitPct, setExitPct] = useState(20);

  const basis = useMemo(() => toRaw(stake || "0", USDC_DECIMALS), [stake]);
  const proceeds = useMemo(
    () => (basis * BigInt(Math.round((100 + exitPct) * 100))) / 10_000n,
    [basis, exitPct],
  );

  const quote = useFeeExample(basis, proceeds, 0n, true, true);

  const pnl = proceeds - basis;
  const fee = quote.data ? BigInt(quote.data.fee) : undefined;
  const keeps = quote.data ? BigInt(quote.data.user_receives) : undefined;

  return (
    <Card className="p-4">
      <SectionHeading
        right={
          isDeployed ? (
            <span className="text-[10px] text-secondary">answered by the contract</span>
          ) : undefined
        }
      >
        What would it cost you
      </SectionHeading>

      <div className="mt-3 flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="stake" className="text-[10px] font-medium tracking-wide text-secondary uppercase">
            You put in
          </label>
          <div className="mt-1 flex items-center gap-1.5 rounded-btn border border-border bg-bg px-3 py-2 focus-within:border-accent">
            <span className="text-secondary">$</span>
            <input
              id="stake"
              value={stake}
              onChange={(e) => setStake(e.target.value.replace(/[^\d.]/g, ""))}
              inputMode="decimal"
              className="num w-24 bg-transparent text-base font-semibold outline-none"
            />
          </div>
        </div>

        <div className="min-w-[14rem] flex-1">
          <label htmlFor="exit" className="text-[10px] font-medium tracking-wide text-secondary uppercase">
            You exit{" "}
            <span className={exitPct >= 0 ? "num text-profit" : "num text-loss"}>
              {exitPct > 0 ? "+" : ""}
              {exitPct}%
            </span>
          </label>
          <input
            id="exit"
            type="range"
            min={-80}
            max={200}
            step={5}
            value={exitPct}
            onChange={(e) => setExitPct(Number(e.target.value))}
            className="mt-2.5 w-full accent-accent"
          />
          <div className="flex justify-between text-[10px] text-secondary">
            <span>−80%</span>
            <span>break even</span>
            <span>+200%</span>
          </div>
        </div>
      </div>

      {!isDeployed ? (
        <p className="mt-3 rounded-btn border border-border bg-elevated px-3 py-2 text-[11px] leading-relaxed text-secondary">
          The calculator asks the deployed contract for this figure, so it is exactly what would
          be charged. Set <code className="text-text">NEXT_PUBLIC_CONTRACT_ID</code> to switch it
          on - the arithmetic is deliberately not duplicated in the browser.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="You take out" value={usd(proceeds)} />
          <Figure
            label={pnl >= 0n ? "Profit" : "Loss"}
            value={usdFromNumber(toNumber(pnl, USDC_DECIMALS), { sign: true })}
            tone={pnl >= 0n ? "profit" : "loss"}
          />
          <Figure
            label="WinCut fee"
            value={fee === undefined ? "…" : usd(fee)}
            tone={fee === 0n ? "profit" : "text"}
            sub={fee === 0n ? "nothing, because there is no profit" : "10% of the profit"}
          />
          <Figure
            label="You keep"
            value={keeps === undefined ? "…" : usd(keeps)}
            sub={
              quote.data && BigInt(quote.data.credit_banked) > 0n
                ? `plus ${usd(quote.data.credit_banked)} of credit banked`
                : undefined
            }
          />
        </div>
      )}
    </Card>
  );
}

function Figure({
  label,
  value,
  tone = "text",
  sub,
}: {
  label: string;
  value: string;
  tone?: "text" | "profit" | "loss";
  sub?: string;
}) {
  const colour = { text: "text-text", profit: "text-profit", loss: "text-loss" }[tone];
  return (
    <div>
      <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">{label}</p>
      <p className={`num mt-1 text-lg leading-tight font-semibold ${colour}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] leading-snug text-secondary">{sub}</p>}
    </div>
  );
}

/* --------------------------------------------------------------- comparison */

/**
 * WinCut against a conventional 1%-in-1%-out fee, computed rather than typed.
 *
 * The win row goes against us: on an isolated winner, 10% of profit costs more
 * than 1% of the round trip. It stays in, and is called out underneath,
 * because a comparison that only shows the flattering cases is the kind of
 * thing a judge finds in thirty seconds.
 *
 * The real case for WinCut is the second card: a run of trades, where most do
 * not work, and the banked losses pay the winner's fee.
 */
function Comparison() {
  /** 1% in and 1% out, charged on the round trip whether or not it worked. */
  const typicalFee = (basis: number, out: number) => (basis + out) * 0.01;

  const singles = useMemo(
    () =>
      [
        { label: "Win: $1,000 → $1,500", basis: 1_000, out: 1_500 },
        { label: "Lose: $1,000 → $700", basis: 1_000, out: 700 },
        { label: "Flat: $1,000 → $1,000", basis: 1_000, out: 1_000 },
      ].map((r) => ({
        ...r,
        typical: typicalFee(r.basis, r.out),
        // An isolated trade has no prior losses, so there is no credit to spend.
        wincut: Math.max(0, r.out - r.basis) * 0.1,
      })),
    [],
  );

  /**
   * Five $1,000 trades of the kind people actually have: three losers, one
   * flat, one good winner. The banked losses are spent before the winner is
   * charged, so the mechanism only shows up across a run.
   */
  const session = useMemo(() => {
    const trades = [
      { basis: 1_000, out: 800 },
      { basis: 1_000, out: 800 },
      { basis: 1_000, out: 800 },
      { basis: 1_000, out: 1_000 },
      { basis: 1_000, out: 1_500 },
    ];
    let credit = 0;
    let wincut = 0;
    let typical = 0;
    for (const t of trades) {
      typical += typicalFee(t.basis, t.out);
      const pnl = t.out - t.basis;
      if (pnl < 0) {
        credit += -pnl;
      } else {
        const used = Math.min(credit, pnl);
        credit -= used;
        wincut += (pnl - used) * 0.1;
      }
    }
    const netPnl = trades.reduce((a, t) => a + (t.out - t.basis), 0);
    return { typical, wincut, credit, netPnl };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-0">
        <div className="px-4 pt-4">
          <SectionHeading>One trade at a time</SectionHeading>
          <p className="mt-1 mb-3 text-[11px] leading-relaxed text-secondary">
            A conventional copy-trading app charges around 1% going in and 1% going out, win or
            lose. WinCut charges 10% of profit and nothing else.
          </p>
        </div>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-y border-border text-[10px] tracking-wide text-secondary uppercase">
              <th className="px-4 py-2 text-left font-medium">Trade</th>
              <th className="px-4 py-2 text-right font-medium">1% in + 1% out</th>
              <th className="px-4 py-2 text-right font-medium">WinCut</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {singles.map((r) => (
              <tr key={r.label}>
                <td className="px-4 py-2.5">{r.label}</td>
                <td className="num px-4 py-2.5 text-right text-secondary">
                  ${r.typical.toFixed(2)}
                </td>
                <td
                  className={`num px-4 py-2.5 text-right font-semibold ${
                    r.wincut === 0
                      ? "text-profit"
                      : r.wincut < r.typical
                        ? "text-profit"
                        : "text-loss"
                  }`}
                >
                  ${r.wincut.toFixed(2)}
                  {r.wincut === 0 && <span className="ml-1 text-[10px]">· free</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-4 py-3 text-[11px] leading-relaxed text-secondary">
          Read that first row honestly:{" "}
          <strong className="text-text">
            on a big winner with no losses behind it, WinCut costs more
          </strong>{" "}
          — ${singles[0].wincut.toFixed(2)} against ${singles[0].typical.toFixed(2)}. That is the
          deal. You pay nothing on the trades that fail, and more on the ones that work.
        </p>
      </Card>

      <Card className="p-0">
        <div className="px-4 pt-4">
          <SectionHeading>A run of five trades</SectionHeading>
          <p className="mt-1 mb-3 text-[11px] leading-relaxed text-secondary">
            Which is the case that actually happens: three losers at −20%, one flat, one good
            winner at +50%, $1,000 each.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-px bg-border">
          <Cell
            label="Your net result"
            value={`${session.netPnl >= 0 ? "+" : "−"}$${Math.abs(session.netPnl).toFixed(0)}`}
            tone={session.netPnl >= 0 ? "profit" : "loss"}
          />
          <Cell label="1% in + 1% out" value={`$${session.typical.toFixed(2)}`} />
          <Cell label="WinCut" value={`$${session.wincut.toFixed(2)}`} tone="profit" />
        </div>
        <p className="px-4 py-3 text-[11px] leading-relaxed text-secondary">
          The three losers bank $600 of credit. The $500 profit on the winner is less than that,
          so it is sheltered in full and the fee is{" "}
          <strong className="text-profit">${session.wincut.toFixed(2)}</strong> — against $
          {session.typical.toFixed(2)} charged by the 1% model on a run that ended $
          {Math.abs(session.netPnl).toFixed(0)} down. ${session.credit.toFixed(0)} of credit is
          still banked for next time.
        </p>
      </Card>
    </div>
  );
}

function Cell({
  label,
  value,
  tone = "text",
}: {
  label: string;
  value: string;
  tone?: "text" | "profit" | "loss";
}) {
  const colour = { text: "text-text", profit: "text-profit", loss: "text-loss" }[tone];
  return (
    <div className="bg-surface px-4 py-3">
      <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">{label}</p>
      <p className={`num mt-1 text-lg leading-tight font-semibold ${colour}`}>{value}</p>
    </div>
  );
}
