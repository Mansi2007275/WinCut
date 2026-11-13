"use client";

/**
 * The bottom half of the trade screen: every trade WinCut has settled, the
 * user's own, the feed of trades credited to the trader they copy, what they
 * have earned, and the leaderboard.
 *
 * All five read the contract's own ring buffer and trader map. Only the last
 * 500 trades are kept on chain - older ones live in the NEP-297 event log, and
 * the empty states say so rather than implying nothing ever happened.
 */

import { useState } from "react";
import Link from "next/link";

import type { LeaderboardRow, TokenConfig, Trade } from "@/lib/contract";
import {
  useClaimable,
  useCopyFeed,
  useLeaderboard,
  useMyTrades,
  useRecentTrades,
  useRefreshAfterTrade,
  useTokens,
} from "@/lib/queries";
import { useWallet } from "@/lib/wallet";
import { isDeployed } from "@/lib/near";
import { isAgent } from "@/lib/agent";
import { claimEarnings } from "@/lib/actions";
import { useToast } from "./Toast";
import { ConnectCta, NeedsContract } from "./Gate";
import { AddressLink, Avatar, Badge, Card, Empty, Loading, SkeletonRows, Tabs } from "./ui";
import {
  ago,
  shortAccount,
  signedNumber,
  signedUsd,
  tokens as fmtTokens,
  usd,
} from "@/lib/format";

type TabKey = "all" | "mine" | "copy" | "earnings" | "board";

export function TradeTabs({
  token,
  followed,
}: {
  /** When set, the feeds are filtered to this token. */
  token?: TokenConfig;
  /** The trader whose copy feed to show. */
  followed?: string | null;
}) {
  const { accountId } = useWallet();
  const [tab, setTab] = useState<TabKey>("all");

  const tabs = [
    { id: "all" as const, label: "All trades" },
    { id: "mine" as const, label: "Yours" },
    { id: "copy" as const, label: "Copy feed" },
    { id: "earnings" as const, label: "Earnings" },
    { id: "board" as const, label: "Leaderboard" },
  ];

  return (
    <Card className="p-0">
      <div className="no-scrollbar overflow-x-auto border-b border-border px-3 pt-3 pb-2">
        <Tabs options={tabs} value={tab} onChange={(v) => setTab(v as TabKey)} />
      </div>
      <div className="p-3">
        {tab === "all" && <AllTrades token={token} />}
        {tab === "mine" && <MyTrades accountId={accountId} token={token} />}
        {tab === "copy" && <CopyFeedTab trader={followed ?? accountId} token={token} />}
        {tab === "earnings" && <Earnings accountId={accountId} />}
        {tab === "board" && <Leaderboard />}
      </div>
    </Card>
  );
}

function AllTrades({ token }: { token?: TokenConfig }) {
  const trades = useRecentTrades(100);
  if (!isDeployed) return <NeedsContract what="trades" />;
  const filtered = token
    ? trades.data?.filter((t) => t.token_id === token.token_id)
    : trades.data;

  if (trades.isPending) return <SkeletonRows rows={4} height="h-12" />;
  if (trades.isError) return <FeedError detail={(trades.error as Error).message} />;
  if (!filtered?.length) {
    return (
      <Empty
        title={token ? `No WinCut trades in ${token.symbol} yet` : "No WinCut trades yet"}
        hint="Every settled trade appears here, newest first, straight from the contract's on-chain ring buffer."
      />
    );
  }
  return <TradeList trades={filtered} showWho />;
}

function MyTrades({ accountId, token }: { accountId: string | null; token?: TokenConfig }) {
  const trades = useMyTrades(accountId, 100);
  if (!isDeployed) return <NeedsContract what="your trades" />;
  if (!accountId) return <ConnectPrompt what="your own trades" />;
  if (trades.isPending) return <Loading label="Reading your trades" />;
  if (trades.isError) return <FeedError detail={(trades.error as Error).message} />;
  const filtered = token ? trades.data?.filter((t) => t.token_id === token.token_id) : trades.data;
  if (!filtered?.length) {
    return (
      <Empty
        title="You have not traded on WinCut yet"
        hint="Buying is free. The fee only ever comes out of a profit you actually realise."
      />
    );
  }
  return <TradeList trades={filtered} />;
}

function CopyFeedTab({ trader, token }: { trader: string | null; token?: TokenConfig }) {
  const feed = useCopyFeed(trader, 100);
  if (!isDeployed) return <NeedsContract what="the copy feed" />;
  if (!trader) {
    return (
      <Empty
        title="Nobody selected"
        hint="Pick a trader to copy in the order panel, and every trade credited to them shows up here."
      />
    );
  }
  if (feed.isPending) return <Loading label="Reading the copy feed" />;
  if (feed.isError) return <FeedError detail={(feed.error as Error).message} />;
  const filtered = token ? feed.data?.filter((t) => t.token_id === token.token_id) : feed.data;
  if (!filtered?.length) {
    return (
      <Empty
        title={`No trades copying ${shortAccount(trader)} yet`}
        hint="A trade lands here when somebody names this trader on the buy that opened their position."
      />
    );
  }
  return (
    <>
      <p className="mb-2 text-[11px] leading-relaxed text-secondary">
        Trades credited to{" "}
        <AddressLink address={trader} tight className="text-[11px]" />. They earn 50% of the fee,
        and only on the ones that exit in profit.
      </p>
      <TradeList trades={filtered} showWho />
    </>
  );
}

function Earnings({ accountId }: { accountId: string | null }) {
  const claimable = useClaimable(accountId);
  const { sign } = useWallet();
  const toast = useToast();
  const refresh = useRefreshAfterTrade(accountId);
  const [busy, setBusy] = useState(false);

  if (!isDeployed) return <NeedsContract what="your earnings" />;
  if (!accountId) return <ConnectPrompt what="what you have earned" />;
  if (claimable.isPending) return <Loading label="Reading your earnings" />;
  if (claimable.isError) return <FeedError detail={(claimable.error as Error).message} />;

  const amount = claimable.data ?? 0n;

  async function claim() {
    setBusy(true);
    const id = toast.push({ kind: "pending", title: `Claiming ${usd(amount)}` });
    try {
      const hash = await sign(claimEarnings());
      toast.update(id, { kind: "confirmed", title: `Claimed ${usd(amount)} USDC`, hash });
      refresh();
    } catch (e) {
      toast.update(id, {
        kind: "failed",
        title: "Claim failed",
        detail: (e as Error).message?.slice(0, 200),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-btn border border-border bg-elevated p-3">
        <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">
          Claimable now
        </p>
        <p className="num mt-1 text-2xl leading-none font-semibold">{usd(amount)}</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-secondary">
          Earned as a copied trader, a referrer, or both. Paid out on request rather than pushed,
          so one account that cannot receive USDC never blocks somebody else&apos;s settlement.
        </p>
      </div>

      <button
        type="button"
        onClick={() => void claim()}
        disabled={amount === 0n || busy}
        className="tap w-full rounded-btn bg-accent py-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
      >
        {busy ? "Signing…" : amount === 0n ? "Nothing to claim" : `Claim ${usd(amount)}`}
      </button>

      {amount === 0n && (
        <p className="text-[11px] leading-relaxed text-secondary">
          You earn when somebody who copied you, or whom you referred, sells at a profit. Share
          your invite link from <Link href="/me" className="text-accent hover:underline">your page</Link>.
        </p>
      )}
    </div>
  );
}

function Leaderboard() {
  const board = useLeaderboard(25);
  if (!isDeployed) return <NeedsContract what="the leaderboard" />;
  if (board.isPending) return <SkeletonRows rows={4} height="h-14" />;
  if (board.isError) return <FeedError detail={(board.error as Error).message} />;
  if (!board.data?.length) {
    return (
      <Empty
        title="No traders yet"
        hint="The board ranks by realised profit, so it fills up as positions are actually closed."
      />
    );
  }
  return <LeaderboardList rows={board.data} />;
}

export function LeaderboardList({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {rows.map((row, i) => {
        const pnl = signedNumber(row.realised_pnl);
        return (
          <li key={row.account_id}>
            <Link
              href={`/trader/${encodeURIComponent(row.account_id)}`}
              className="flex items-center gap-3 py-2.5 transition-colors hover:bg-elevated"
            >
              <span className="num w-5 shrink-0 text-center text-[11px] text-secondary">
                {i + 1}
              </span>
              <Avatar address={row.account_id} size={28} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="num truncate text-[13px] font-medium">
                    {shortAccount(row.account_id)}
                  </span>
                  {/* Marked on the board too, not only on its own page: this is
                      the screen people pick a trader to copy from. */}
                  {isAgent(row.account_id) && <Badge tone="accent">AI Agent</Badge>}
                </span>
                <span className="block text-[10px] text-secondary">
                  {row.trades} trades · {row.wins}W / {row.losses}L · {row.followers} copying
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span
                  className={`num block text-[13px] font-semibold ${
                    pnl > 0 ? "text-profit" : pnl < 0 ? "text-loss" : "text-secondary"
                  }`}
                >
                  {signedUsd(row.realised_pnl)}
                </span>
                <span className="num block text-[10px] text-secondary">
                  {usd(row.earnings_usdc)} earned
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function TradeList({ trades, showWho }: { trades: Trade[]; showWho?: boolean }) {
  const tokens = useTokens();
  const symbolOf = (id: string) =>
    tokens.data?.find((t) => t.token_id === id)?.symbol ?? shortAccount(id);
  const decimalsOf = (id: string) =>
    tokens.data?.find((t) => t.token_id === id)?.decimals ?? 18;

  return (
    <ul className="flex flex-col divide-y divide-border">
      {trades.map((t) => {
        const buy = t.side === "Buy";
        const pnl = t.pnl ? signedNumber(t.pnl) : null;
        const fee = BigInt(t.fee);
        return (
          <li key={`${t.id}-${t.timestamp}`} className="flex items-center gap-3 py-2.5">
            <Badge tone={buy ? "accent" : pnl !== null && pnl < 0 ? "loss" : "profit"}>
              {buy ? "buy" : "sell"}
            </Badge>

            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">
                <Link
                  href={`/trade/${encodeURIComponent(t.token_id)}`}
                  className="font-medium hover:text-accent"
                >
                  {symbolOf(t.token_id)}
                </Link>
                <span className="num ml-1.5 text-secondary">
                  {fmtTokens(t.amount, decimalsOf(t.token_id))}
                </span>
              </span>
              <span className="block text-[10px] text-secondary">
                {showWho && (
                  <>
                    <AddressLink address={t.user} tight className="text-[10px]" /> ·{" "}
                  </>
                )}
                {ago(t.timestamp)}
                {t.followed && (
                  <>
                    {" · copying "}
                    <AddressLink address={t.followed} tight className="text-[10px]" />
                  </>
                )}
              </span>
            </span>

            <span className="shrink-0 text-right">
              <span className="num block text-[13px] font-medium">{usd(t.usdc)}</span>
              {pnl !== null ? (
                <span
                  className={`num block text-[10px] ${
                    pnl > 0 ? "text-profit" : pnl < 0 ? "text-loss" : "text-secondary"
                  }`}
                >
                  {signedUsd(t.pnl)}
                  {fee === 0n ? (
                    <span className="ml-1 text-profit">· $0 fee</span>
                  ) : (
                    <span className="ml-1 text-secondary">· {usd(fee)} fee</span>
                  )}
                </span>
              ) : (
                <span className="block text-[10px] text-profit">0% fee</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ConnectPrompt({ what }: { what: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <p className="text-xs text-secondary">Connect a wallet to see {what}.</p>
      <div className="w-48">
        <ConnectCta />
      </div>
    </div>
  );
}

function FeedError({ detail }: { detail: string }) {
  return (
    <div className="rounded-btn border border-loss/30 bg-loss-dim p-3">
      <p className="text-xs font-semibold text-loss">Could not read the contract</p>
      <p className="mt-1 text-[11px] break-words text-secondary">{detail}</p>
    </div>
  );
}
