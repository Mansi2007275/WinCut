"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { isAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { Page } from "@/components/Shell";
import {
  AddressLink,
  Badge,
  Button,
  Card,
  DumperStamp,
  Empty,
  ErrorBox,
  HonestyBar,
  SkeletonRows,
  StatTile,
  TxLink,
} from "@/components/ui";
import { useCoins, useHead, useTrader } from "@/lib/data";
import { isDeployed } from "@/lib/chain";
import { copyLink } from "@/lib/referral";
import { reason } from "@/components/TradePanel";
import { ago, coins as fmtCoins, usd } from "@/lib/format";

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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl uppercase leading-none">Trader</h1>
          <p className="mt-1 break-all font-mono text-xs">{target}</p>
          <p className="mt-1">
            <AddressLink address={target} label="open in explorer ↗" className="text-[10px]" />
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {isMe && <Badge tone="brand">you</Badge>}
          {p?.isDumper && <DumperStamp />}
          {p && !p.isDumper && p.followers.length > 0 && p.followersPnl > 0n && (
            <Badge tone="profit">honest</Badge>
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
          {/* ------------------------- honesty ------------------------- */}
          <Card tone={p.isDumper ? "loss" : "white"} className={`p-4 ${p.isDumper ? "text-white" : ""}`}>
            <p className="font-display text-sm uppercase">Followers&apos; profit</p>
            <p className="mt-1 text-xs leading-snug opacity-80">
              The only number that matters here: did the people who copied this wallet make money?
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
                <span className="font-display text-[10px] uppercase opacity-70">Honesty</span>
                <span className="money text-xs">
                  {p.honesty === null ? "—" : p.honesty.toFixed(2)}
                </span>
              </div>
              <HonestyBar score={p.honesty} />
              <p className="mt-1 font-mono text-[10px] leading-snug opacity-70">
                Followers&apos; PnL divided by their own. Above 1 means the people copying made
                more than the trader did; below 0 means the trader profited while followers lost.
              </p>
            </div>
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

          {/* --------------------------- copy --------------------------- */}
          {!isMe && (
            <Card tone="brand" className="p-4">
              <p className="font-display text-sm uppercase">Copy this trader</p>
              <p className="mt-1 text-xs leading-snug">
                Your buy records them on chain. They earn 50% of the fee — but only out of your
                profit. If you exit at a loss, they earn nothing.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {coins.data?.slice(0, 3).map((c) => (
                  <Link key={c.address} href={`/coin/${c.address}?follow=${target}`}>
                    <span className="nb-sm nb-press inline-block bg-ink px-3 py-2 font-display text-[10px] uppercase text-brand">
                      Copy on {c.symbol}
                    </span>
                  </Link>
                ))}
              </div>
              <Button tone="white" className="mt-3 w-full" onClick={share}>
                {copied ? "Link copied" : "Copy invite link"}
              </Button>
              <p className="mt-2 break-all font-mono text-[10px] text-ink/60">
                {copyLink(target)}
              </p>
            </Card>
          )}

          {/* ------------------------- history ------------------------- */}
          <div>
            <h2 className="mb-2 text-lg uppercase">Trade history</h2>
            <div className="flex flex-col gap-2">
              {p.history.slice(0, 25).map((t) => {
                const coin = coins.data?.find((c) => c.poolId === t.poolId);
                return (
                  <Card key={`${t.tx}-${t.kind}-${t.block}`} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2">
                          <Badge tone={t.kind === "buy" ? "brand" : "white"}>{t.kind}</Badge>
                          {coin ? (
                            <Link
                              href={`/coin/${coin.address}`}
                              className="font-display text-xs uppercase underline"
                            >
                              {coin.symbol}
                            </Link>
                          ) : (
                            <span className="font-mono text-[10px] text-muted">
                              {t.poolId.slice(0, 10)}…
                            </span>
                          )}
                        </p>
                        <p className="money mt-1 text-xs">
                          {fmtCoins(t.coins)} · {usd(t.quoteAmount)}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {t.kind === "sell" && (
                          <>
                            <p
                              className={`money text-sm ${
                                (t.pnl ?? 0n) >= 0n ? "text-[#00a152]" : "text-[#d32f45]"
                              }`}
                            >
                              {usd(t.pnl, { sign: true })}
                            </p>
                            <p className="money text-[10px] text-muted">
                              fee {usd(t.fee)}
                              {(t.fee ?? 0n) === 0n && " · free"}
                            </p>
                          </>
                        )}
                        <p className="font-mono text-[10px] text-muted">{ago(t.block, head.data)}</p>
                        <TxLink hash={t.tx} />
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
