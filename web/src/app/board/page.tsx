"use client";

import { useState } from "react";
import { Page } from "@/components/Shell";
import { Card, Tabs, Loading, Empty, ErrorBox, DumperStamp, HonestyBar, Badge } from "@/components/ui";
import { useLeaderboard, type LeaderRow } from "@/lib/data";
import { usd, handle, short } from "@/lib/format";

type BoardTab = "own" | "followers";

export default function BoardPage() {
  const [tab, setTab] = useState<BoardTab>("own");
  const { rows, isLoading, error } = useLeaderboard();

  const sorted = rows
    ? [...rows].sort((a, b) =>
        tab === "own"
          ? Number(b.ownPnl - a.ownPnl)
          : Number(b.followersPnl - a.followersPnl),
      )
    : undefined;

  return (
    <Page>
      <div>
        <h1 className="text-2xl uppercase">Leaderboard</h1>
        <p className="mt-1 text-xs text-muted">
          Built from WinCutHook events on chain. No indexer, nothing seeded.
        </p>
      </div>

      <Tabs
        options={[
          { id: "own" as BoardTab, label: "Own profit" },
          { id: "followers" as BoardTab, label: "Followers' profit" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "followers" && (
        <div className="nb-sm bg-brand p-3">
          <p className="text-[11px] font-bold leading-snug">
            This is the board that matters. A trader can look great on their own
            profit while the people copying them lose money. Under WinCut they
            earn nothing from those followers.
          </p>
        </div>
      )}

      {isLoading && <Loading label="Reading hook events" />}
      {error && <ErrorBox title="Cannot read events" detail={String(error)} />}

      {sorted && sorted.length === 0 && (
        <Empty
          title="No trades yet"
          hint="No trades yet. Be the first."
        />
      )}

      {sorted?.map((r, i) => (
        <RowCard key={r.trader} row={r} rank={i + 1} tab={tab} />
      ))}
    </Page>
  );
}

function RowCard({ row, rank, tab }: { row: LeaderRow; rank: number; tab: BoardTab }) {
  const highlight = tab === "followers" && row.isDumper;
  const primary = tab === "own" ? row.ownPnl : row.followersPnl;

  return (
    <Card tone={highlight ? "loss" : "white"} className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-base">#{rank}</span>
            <span className={`font-display text-base ${highlight ? "text-white" : ""}`}>
              {handle(row.trader)}
            </span>
            {row.isDumper && <DumperStamp />}
            {!row.isDumper && row.followers > 0 && row.followersPnl > 0n && (
              <Badge tone="profit">Honest</Badge>
            )}
          </div>
          <p className={`font-mono text-[10px] ${highlight ? "text-white/80" : "text-muted"}`}>
            {short(row.trader)}
          </p>
        </div>

        <div className="text-right">
          <p
            className={`money text-xl ${
              highlight ? "text-white" : primary >= 0n ? "text-[#00a152]" : "text-[#d32f45]"
            }`}
          >
            {usd(primary, { sign: true })}
          </p>
          <p className={`text-[10px] ${highlight ? "text-white/80" : "text-muted"}`}>
            {tab === "own" ? "own profit" : `from ${row.followers} follower${row.followers === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
        <Mini label="Own" value={usd(row.ownPnl, { sign: true })} invert={highlight} positive={row.ownPnl >= 0n} />
        <Mini
          label="Followers"
          value={usd(row.followersPnl, { sign: true })}
          invert={highlight}
          positive={row.followersPnl >= 0n}
        />
        <Mini
          label="Win rate"
          value={row.trades ? `${Math.round((row.wins / row.trades) * 100)}%` : "—"}
          invert={highlight}
        />
        <Mini label="Exits" value={String(row.trades)} invert={highlight} />
      </div>

      <div className="mt-3">
        <div className="mb-1 flex items-baseline justify-between">
          <span className={`text-[10px] font-bold uppercase ${highlight ? "text-white/80" : "text-muted"}`}>
            Honesty score
          </span>
          <span className={`money text-[11px] ${highlight ? "text-white" : ""}`}>
            {row.honesty === null ? "—" : row.honesty.toFixed(2)}
          </span>
        </div>
        <HonestyBar score={row.honesty} />
        <p className={`mt-1 text-[10px] ${highlight ? "text-white/80" : "text-muted"}`}>
          followers&apos; profit ÷ own profit
        </p>
      </div>
    </Card>
  );
}

function Mini({
  label, value, invert, positive,
}: { label: string; value: string; invert?: boolean; positive?: boolean }) {
  const tone =
    positive === undefined
      ? invert ? "text-white" : "text-ink"
      : invert ? "text-white" : positive ? "text-[#00a152]" : "text-[#d32f45]";
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={`text-[10px] uppercase ${invert ? "text-white/70" : "text-muted"}`}>{label}</span>
      <span className={`money text-xs ${tone}`}>{value}</span>
    </div>
  );
}
