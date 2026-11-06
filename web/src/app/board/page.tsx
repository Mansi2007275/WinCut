"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Page } from "@/components/Shell";
import {
  Avatar,
  Badge,
  Card,
  ColumnHeader,
  DumperStamp,
  Empty,
  ErrorBox,
  HonestyBar,
  Segmented,
  SkeletonRows,
} from "@/components/ui";
import { useLeaderboard, type LeaderRow } from "@/lib/data";
import { isDeployed } from "@/lib/chain";
import { short, usd } from "@/lib/format";

type BoardTab = "own" | "followers";

const TABS = [
  { id: "own" as const, label: "Own profit" },
  { id: "followers" as const, label: "Followers' profit" },
];

export default function BoardPage() {
  const [tab, setTab] = useState<BoardTab>("own");
  const { rows, isLoading, error } = useLeaderboard();

  const sorted = useMemo(
    () =>
      rows
        ? [...rows].sort((a, b) =>
            tab === "own" ? Number(b.ownPnl - a.ownPnl) : Number(b.followersPnl - a.followersPnl),
          )
        : undefined,
    [rows, tab],
  );

  const dumpers = (rows ?? []).filter((r) => r.isDumper);

  return (
    <Page>
      <header>
        <h1 className="text-2xl font-semibold">Leaderboard</h1>
        <p className="mt-1.5 text-sm leading-snug text-secondary">
          Ranked by what followers actually made, from WinCut hook events on chain. No indexer,
          nothing seeded.
        </p>
      </header>

      <Segmented options={TABS} value={tab} onChange={setTab} />

      {tab === "followers" && (
        <Card tone="accent" className="p-3">
          <p className="text-[12px] leading-snug text-text/85">
            This is the board that matters. A trader can look great on their own profit while the
            people copying them lose money. Under WinCut they earn nothing from those followers.
          </p>
        </Card>
      )}

      {isLoading && <SkeletonRows rows={3} height="h-24" />}
      {error && <ErrorBox title="Cannot read events" detail={String(error)} />}

      {isDeployed && sorted && sorted.length === 0 && (
        <Empty
          title="No trades yet. Be the first."
          hint="Every row on this board comes from a real exit on Arc testnet. Until someone closes a position there is genuinely nothing to rank."
        />
      )}

      {sorted && sorted.length > 0 && (
        <>
          <ColumnHeader>
            <span>Trader</span>
            <span>{tab === "own" ? "Own profit" : "Followers"}</span>
          </ColumnHeader>
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {sorted.map((r, i) => (
                <motion.div
                  key={r.trader}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, layout: { duration: 0.28 } }}
                >
                  <RowCard row={r} rank={i + 1} tab={tab} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </>
      )}

      {/* The dumper explainer stays visible even with nobody flagged: it is
          the rule the second board exists to enforce, and saying it only once
          somebody is caught would make it read as an accusation. */}
      {sorted && sorted.length > 0 && (
        <Card className="p-4">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <DumperStamp />
            {dumpers.length === 0
              ? "No dumpers yet"
              : `${dumpers.length} dumper${dumpers.length === 1 ? "" : "s"} flagged`}
          </p>
          <p className="mt-1.5 text-[12px] leading-snug text-secondary">
            A trader is flagged when their own profit is positive while the people copying them
            lose. They earn nothing from those followers.
          </p>
        </Card>
      )}

      {sorted && sorted.length > 0 && (
        <Card className="p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold">Honesty score</span>
            <span className="text-[11px] text-secondary">followers&apos; profit ÷ own profit</span>
          </div>
          <div className="mt-2.5 h-1.5 w-full rounded-pill bg-gradient-to-r from-loss via-secondary to-profit" />
          <div className="mt-1.5 flex justify-between text-[10px] text-secondary">
            <span>Dumped on followers</span>
            <span>Neutral</span>
            <span>Followers won</span>
          </div>
        </Card>
      )}
    </Page>
  );
}

function RowCard({ row, rank, tab }: { row: LeaderRow; rank: number; tab: BoardTab }) {
  const primary = tab === "own" ? row.ownPnl : row.followersPnl;
  const honest = !row.isDumper && row.followers > 0 && row.followersPnl > 0n;

  return (
    <Link href={`/trader/${row.trader}`}>
      <Card
        tone={row.isDumper && tab === "followers" ? "loss" : "surface"}
        className="p-3 transition-colors hover:bg-elevated/40"
      >
        <div className="flex items-center gap-3">
          <span className="num w-4 shrink-0 text-center text-xs text-secondary">{rank}</span>
          <Avatar address={row.trader} size={34} />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5">
              {/* Addresses, not invented handles. A made-up name implies the
                  app knows who this is, which it does not. */}
              <span className="num text-sm font-semibold">{short(row.trader)}</span>
              {row.isDumper && <DumperStamp />}
              {honest && <Badge tone="profit">Honest</Badge>}
            </p>
            <p className="num mt-0.5 truncate text-[11px] text-secondary">
              {row.followers} follower{row.followers === 1 ? "" : "s"} · own{" "}
              {usd(row.ownPnl, { sign: true })}
              {row.trades > 0 && (
                <> · win rate {Math.round((row.wins / row.trades) * 100)}%</>
              )}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p
              className={`num text-sm font-semibold ${
                primary > 0n ? "text-profit" : primary < 0n ? "text-loss" : "text-text"
              }`}
            >
              {usd(primary, { sign: true })}
            </p>
            <p className="text-[10px] text-secondary">
              {tab === "own" ? "own profit" : "followers"}
            </p>
          </div>
        </div>

        <div className="mt-2.5">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[10px] tracking-wide text-secondary uppercase">Honesty</span>
            <span className="num text-[11px] text-secondary">
              {row.honesty === null ? "—" : row.honesty.toFixed(2)}
            </span>
          </div>
          <HonestyBar score={row.honesty} />
        </div>
      </Card>
    </Link>
  );
}
