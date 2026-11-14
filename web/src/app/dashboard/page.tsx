"use client";

/**
 * /dashboard - The Cut Field.
 *
 * The one screen that answers "what has this thing actually done?" in numbers
 * a stranger can check. Everything on it is derived in the browser from the
 * contract's trade ring and a handful of named view calls; nothing is cached
 * server-side, nothing is pre-computed, and there is no figure here that the
 * page could still show if the chain went away.
 *
 * It is a trading terminal rather than a marketing page on purpose. Green is
 * profit, red is loss, amber is a fee and nothing else, muted blue is a banked
 * credit. If the screen has no amber on it, the protocol earned nothing - and
 * that is a thing the design should make obvious at a glance rather than
 * something you have to read a paragraph to learn.
 */

import { useMemo } from "react";

import { CutField } from "@/components/cutfield/CutField";
import {
  BoardPanel,
  FeeSplitPanel,
  KpiStrip,
  SolvencyPanel,
  StripsPanel,
  TapePanel,
} from "@/components/cutfield/Panels";
import { Page } from "@/components/Shell";
import { ErrorBox, Loading } from "@/components/ui";
import { boardRows, decodeRing, feeSplit, totals, tradersInRing } from "@/lib/cutfield";
import { toNumber } from "@/lib/format";
import { USDC_DECIMALS, isDeployed } from "@/lib/near";
import {
  useAgentLog,
  useConfig,
  useContractUsdcHeld,
  useLeaderboard,
  useLossCredits,
  useSolvency,
  useTokens,
  useTradeRing,
} from "@/lib/queries";

export default function DashboardPage() {
  const ringQuery = useTradeRing(500);
  const tokens = useTokens();
  const config = useConfig();
  const board = useLeaderboard(25);
  const agent = useAgentLog(true, 10);
  const solvency = useSolvency();
  const held = useContractUsdcHeld();

  const symbols = useMemo(
    () => new Map((tokens.data ?? []).map((t) => [t.token_id, t.symbol])),
    [tokens.data],
  );

  const ring = useMemo(() => decodeRing(ringQuery.data, symbols), [ringQuery.data, symbols]);
  const agg = useMemo(() => totals(ring), [ring]);
  const split = useMemo(() => feeSplit(agg.feesCharged, config.data), [agg.feesCharged, config.data]);
  const rows = useMemo(() => boardRows(board.data), [board.data]);

  // The markets to lay out as lanes: the ones the contract lists, in env
  // order, so the field's z axis matches the strips underneath it.
  const markets = useMemo(() => (tokens.data ?? []).map((t) => t.symbol), [tokens.data]);

  const accounts = useMemo(() => tradersInRing(ring), [ring]);
  const credits = useLossCredits(accounts);
  const creditHeld = useMemo(() => {
    if (!credits.data) return undefined;
    const vals = Object.values(credits.data).filter((v) => Number.isFinite(v));
    return vals.reduce((a, b) => a + b, 0);
  }, [credits.data]);

  if (!isDeployed) {
    return (
      <Page width="full" banners>
        <ErrorBox
          title="No contract configured"
          detail="This page reads everything from the WinCut contract. Set NEXT_PUBLIC_CONTRACT_ID to point it at a deployment."
        />
      </Page>
    );
  }

  return (
    <Page width="full" banners>
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="mono text-[20px] font-semibold tracking-tight">The Cut Field</h1>
          <p className="mono mt-0.5 text-[11px] text-secondary">
            Every settled trade, the fee it paid, and where that fee went. Read from chain,
            re-read every 15 seconds.
          </p>
        </div>
        <p className="mono text-[10px] text-secondary">
          ring {agg.trades}/{config.data?.trade_ring_capacity ?? 500} ·{" "}
          {config.data ? `fee ${config.data.fee_bps_of_profit / 100}% of profit` : "…"}
        </p>
      </header>

      {ringQuery.isError && (
        <ErrorBox title="Cannot read the trade ring" detail={(ringQuery.error as Error)?.message} />
      )}

      <KpiStrip totals={agg} creditHeld={creditHeld} />

      {ringQuery.isLoading && ring.length === 0 ? (
        <Loading label="Reading the trade ring" />
      ) : (
        <CutField ring={ring} markets={markets} />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <FeeSplitPanel split={split} totals={agg} />
        <SolvencyPanel
          held={held.data}
          accounted={solvency.data}
          shortfall={
            config.data ? toNumber(config.data.shortfall_usdc, USDC_DECIMALS) : undefined
          }
        />
      </div>

      <StripsPanel tokens={tokens.data ?? []} />

      <div className="grid gap-4 lg:grid-cols-2">
        <BoardPanel rows={rows} />
        <TapePanel
          decisions={agent.data?.decisions}
          detail={agent.data?.detail ?? (agent.isError ? (agent.error as Error)?.message : undefined)}
          configured={Boolean(agent.data?.configured)}
        />
      </div>
    </Page>
  );
}
