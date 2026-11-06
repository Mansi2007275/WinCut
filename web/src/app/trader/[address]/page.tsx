"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { isAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { Page } from "@/components/Shell";
import {
  AddressLink,
  Avatar,
  Badge,
  Button,
  Card,
  DumperStamp,
  Empty,
  ErrorBox,
  HonestyBar,
  SectionHeading,
  SkeletonRows,
  StatTile,
  TxLink,
} from "@/components/ui";
import { reason } from "@/components/TradePanel";
import { useCoins, useEarnings, useHead, useTrader } from "@/lib/data";
import { isDeployed } from "@/lib/chain";
import { copyLink } from "@/lib/referral";
import { ago, coins as fmtCoins, short, usd } from "@/lib/format";

export default function TraderPage() {
  return (
    <Suspense
      fallback={
        <Page>
          <SkeletonRows rows={3} height="h-24" />
        </Page>
      }
    >
      <TraderScreen />
    </Suspense>
  );
}

function TraderScreen() {
  const params = useParams<{ address: string }>();
  const raw = params?.address ?? "";
  const target = isAddress(raw) ? (raw as Address) : undefined;

  const { address: me } = useAccount();
  const { profile, isLoading, error } = useTrader(target);
  const earnings = useEarnings(target);
  const coins = useCoins();
  const head = useHead();
  const [copied, setCopied] = useState(false);

  if (!target) {
    return (
      <Page>
        <ErrorBox title="Not a valid address" detail={raw} />
      </Page>
    );
  }
  if (!isDeployed) {
    return (
      <Page>
        <Empty title="Waiting on a deployment" />
      </Page>
    );
  }
  if (isLoading) {
    return (
      <Page>
        <SkeletonRows rows={3} height="h-24" />
      </Page>
    );
  }
  if (error) {
    return (
      <Page>
        <ErrorBox title="Cannot reach Arc" detail={reason(error)} />
      </Page>
    );
  }

  const p = profile;
  const isMe = me?.toLowerCase() === target.toLowerCase();
  const winRate = p && p.trades > 0 ? Math.round((p.wins / p.trades) * 100) : null;

  async function share() {
    const link = copyLink(target!);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard is blocked in some contexts; the link is shown below anyway.
      setCopied(false);
    }
  }

  return (
    <Page>
      {/* ------------------------------------------------------- header */}
      <div className="flex items-center gap-3">
        <Link
          href="/board"
          aria-label="Back to the leaderboard"
          className="tap flex w-10 shrink-0 items-center justify-center rounded-pill border border-border bg-surface text-secondary transition-colors hover:text-text"
        >
          ‹
        </Link>
        <Avatar address={target} size={40} />
        <div className="min-w-0 flex-1">
          <p className="num truncate text-base leading-tight font-semibold">{short(target)}</p>
          <p className="mt-0.5 text-[11px]">
            <AddressLink address={target} label="open in explorer ↗" />
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {isMe && <Badge tone="accent">you</Badge>}
          {p?.isDumper && <DumperStamp />}
          {p && !p.isDumper && p.followers.length > 0 && p.followersPnl > 0n && (
            <Badge tone="profit">Honest</Badge>
          )}
        </div>
      </div>

      {!p || p.trades === 0 ? (
        <Empty
          title="No closed trades yet"
          hint="This wallet has not exited a position on WinCut, so there is nothing to score. An honesty number from zero trades would be made up."
        />
      ) : (
        <>
          {/* ------------------------------------------------- honesty */}
          <Card tone={p.isDumper ? "loss" : "surface"} className="p-4">
            <p className="text-sm font-semibold">Followers&apos; profit</p>
            <p className="mt-1 text-xs leading-snug text-secondary">
              The only number that matters here: did the people who copied this wallet make
              money?
            </p>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <StatTile
                label="Their own PnL"
                value={usd(p.ownPnl, { sign: true })}
                tone={p.ownPnl >= 0n ? "profit" : "loss"}
              />
              <StatTile
                label="Followers' PnL"
                value={usd(p.followersPnl, { sign: true })}
                tone={p.followersPnl >= 0n ? "profit" : "loss"}
              />
            </div>

            <div className="mt-3">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[10px] tracking-wide text-secondary uppercase">Honesty</span>
                <span className="num text-xs">
                  {p.honesty === null ? "—" : p.honesty.toFixed(2)}
                </span>
              </div>
              <HonestyBar score={p.honesty} />
              <p className="mt-1.5 text-[11px] leading-snug text-secondary">
                Followers&apos; PnL divided by their own. Above 1 means the people copying made
                more than the trader did; below 0 means the trader profited while followers lost.
              </p>
            </div>
          </Card>

          {/* ------------------------------- earned from followers */}
          <Card className="p-4">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold">Earned from followers</p>
              <p className="num text-base font-semibold text-profit">
                {earnings.isPending ? "…" : usd(earnings.data?.total)}
              </p>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <StatTile
                label="As copied trader"
                value={usd(earnings.data?.asCopiedTrader)}
                sub="50% of each fee"
              />
              <StatTile
                label="As referrer"
                value={usd(earnings.data?.asReferrer)}
                sub="20% of each fee"
              />
            </div>
            <p className="mt-2 text-[11px] leading-snug text-secondary">
              Summed from every FeeSplit event this wallet appears in, so it counts what they have
              been paid in total — not just what is still sitting unclaimed in the hook.
            </p>
          </Card>

          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Closed trades" value={p.trades} />
            <StatTile label="Win rate" value={winRate === null ? "—" : `${winRate}%`} />
            <StatTile label="Fees paid" value={usd(p.feesPaid)} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <StatTile label="Followers" value={p.followers.length} />
            <StatTile label="Copying" value={p.copying.length} />
          </div>

          {/* ---------------------------------------------------- copy */}
          {!isMe && (
            <Card tone="accent" className="p-4">
              <p className="text-sm font-semibold text-accent">Copy this trader</p>
              <p className="mt-1 text-xs leading-snug text-text/85">
                Your buy records them on chain. They earn 50% of the fee — but only out of your
                profit. If you exit at a loss, they earn nothing.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {coins.data?.slice(0, 3).map((c) => (
                  <Link key={c.address} href={`/coin/${c.address}?follow=${target}`}>
                    <span className="tap inline-flex items-center rounded-btn bg-accent px-3 text-xs font-semibold text-white">
                      Copy on {c.symbol}
                    </span>
                  </Link>
                ))}
              </div>
              <Button tone="elevated" className="mt-3 w-full" onClick={share}>
                {copied ? "Link copied ✓" : "Copy invite link"}
              </Button>
              <p className="mt-2 text-[11px] break-all text-secondary">{copyLink(target)}</p>
            </Card>
          )}

          {/* ------------------------------------------------- history */}
          <section className="flex flex-col gap-2">
            <SectionHeading>Trade history</SectionHeading>
            <Card className="divide-y divide-border">
              {p.history.slice(0, 25).map((t) => {
                const coin = coins.data?.find((c) => c.poolId === t.poolId);
                return (
                  <div key={`${t.tx}-${t.kind}-${t.block}`} className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-[13px]">
                        <span
                          className={`font-semibold ${
                            t.kind === "sell" ? "text-loss" : "text-profit"
                          }`}
                        >
                          {t.kind === "sell" ? "Sell" : "Buy"}
                        </span>
                        {coin ? (
                          <Link
                            href={`/coin/${coin.address}`}
                            className="font-semibold underline-offset-2 hover:underline"
                          >
                            {coin.symbol}
                          </Link>
                        ) : (
                          <span className="num text-[11px] text-secondary">
                            {t.poolId.slice(0, 10)}…
                          </span>
                        )}
                      </p>
                      <p className="num mt-0.5 text-[11px] text-secondary">
                        {fmtCoins(t.coins)} · {ago(t.block, head.data)} ·{" "}
                        <TxLink hash={t.tx}>explorer ↗</TxLink>
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="num text-sm font-semibold">{usd(t.quoteAmount)}</p>
                      {t.kind === "sell" && (
                        <p
                          className={`num text-[11px] ${
                            (t.pnl ?? 0n) >= 0n ? "text-profit" : "text-loss"
                          }`}
                        >
                          {usd(t.pnl, { sign: true })}
                          {(t.fee ?? 0n) === 0n ? " · fee $0" : ` · fee ${usd(t.fee)}`}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </Card>
          </section>
        </>
      )}
    </Page>
  );
}
