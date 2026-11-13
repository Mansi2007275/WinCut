"use client";

/**
 * A trader's public page.
 *
 * The honest framing matters here: a trader on WinCut earns only when the
 * people copying them exit in profit, so their earnings figure is itself
 * evidence about whether copying them has worked. That is shown next to their
 * own realised result rather than instead of it.
 */

import { use, useState } from "react";
import Link from "next/link";

import { Page } from "@/components/Shell";
import { AgentKeyNote, AgentReasoning } from "@/components/AgentPanel";
import { TradeList } from "@/components/TradeTabs";
import { Avatar, Badge, Card, Empty, SectionHeading, SkeletonRows, StatTile, Tabs } from "@/components/ui";
import { NeedsContract } from "@/components/Gate";
import { useAgentLog, useCopyFeed, useMyTrades, useTrader } from "@/lib/queries";
import { isAgent } from "@/lib/agent";
import { useWallet } from "@/lib/wallet";
import { copyLink } from "@/lib/referral";
import { explorerAccount } from "@/lib/explorer";
import { isDeployed } from "@/lib/near";
import { signedNumber, signedUsd, usd } from "@/lib/format";

export default function TraderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const accountId = decodeURIComponent(id);
  return <TraderBody accountId={accountId} />;
}

function TraderBody({ accountId }: { accountId: string }) {
  const me = useWallet().accountId;
  const trader = useTrader(accountId);
  const own = useMyTrades(accountId, 100);
  const copied = useCopyFeed(accountId, 100);
  const agent = isAgent(accountId);
  const agentLog = useAgentLog(agent);
  const [tab, setTab] = useState<"own" | "copied">("own");
  const [copiedLink, setCopiedLink] = useState(false);

  const pnl = trader.data ? signedNumber(trader.data.realised_pnl) : 0;
  const link = copyLink(accountId);
  const isMe = me === accountId;

  return (
    <Page width="lg">
      <header className="flex flex-wrap items-center gap-3">
        <Avatar address={accountId} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="num truncate text-lg leading-tight font-semibold">{accountId}</h1>
            {agent && <Badge tone="accent">AI Agent</Badge>}
          </div>
          <a
            href={explorerAccount(accountId)}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-accent underline-offset-2 hover:underline"
          >
            on NearBlocks ↗
          </a>
        </div>
        {isMe && (
          <Link
            href="/me"
            className="rounded-btn border border-border px-3 py-1.5 text-[11px] font-medium text-secondary hover:text-text"
          >
            this is you
          </Link>
        )}
      </header>

      {agent && (
        <>
          <Card className="p-3">
            <p className="text-[11px] leading-relaxed text-secondary">
              Nobody picks these trades. This account runs on a five-minute loop that reads the
              chain, decides, and records what it decided - the reasoning behind every entry is
              below. Its results are read from the contract exactly as any other trader&rsquo;s
              are, and copying it carries the same risk as copying a person, with none of a
              person&rsquo;s judgement about when a market has stopped making sense.
            </p>
          </Card>
          <AgentKeyNote />
        </>
      )}

      {!isDeployed ? null : trader.isPending ? (
        <SkeletonRows rows={1} height="h-20" />
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="Realised P&L"
            tone={pnl > 0 ? "profit" : pnl < 0 ? "loss" : "text"}
            value={trader.data ? signedUsd(trader.data.realised_pnl) : "…"}
            sub="closed positions only"
          />
          <StatTile
            label="Earned from copiers"
            tone="accent"
            value={trader.data ? usd(trader.data.earnings_usdc) : "…"}
            sub="50% of their profit fees"
          />
          <StatTile
            label="Copying them"
            value={trader.data ? String(trader.data.followers) : "…"}
            sub="distinct accounts"
          />
          <StatTile
            label="Record"
            value={trader.data ? `${trader.data.wins}W / ${trader.data.losses}L` : "…"}
            sub={trader.data ? `${trader.data.trades} trades · ${usd(trader.data.volume_usdc)} volume` : undefined}
          />
        </div>
      )}

      {trader.data && trader.data.trades === 0 && (
        <Card className="p-3">
          <p className="text-[11px] leading-relaxed text-secondary">
            This account has not traded on WinCut. The page is real and the numbers are read from
            the contract - there is simply nothing yet.
          </p>
        </Card>
      )}

      {agent && (
        <AgentReasoning
          log={agentLog.data}
          isPending={agentLog.isPending}
          error={agentLog.error as Error | null}
        />
      )}

      <Card className="p-3">
        <SectionHeading>Copy this trader</SectionHeading>
        <p className="mt-1 text-[11px] leading-relaxed text-secondary">
          Anyone opening a position through this link credits {accountId} with 50% of the WinCut
          fee - charged only if that position is eventually closed in profit. A losing copier
          costs them nothing and earns them nothing.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-btn border border-border bg-bg px-3 py-2 text-[11px] text-secondary">
            {link || "…"}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(link);
              setCopiedLink(true);
              setTimeout(() => setCopiedLink(false), 1800);
            }}
            className="tap shrink-0 rounded-btn border border-border bg-surface px-3 py-2 text-[11px] font-medium hover:bg-elevated"
          >
            {copiedLink ? "copied" : "copy"}
          </button>
        </div>
      </Card>

      <section className="flex flex-col gap-2">
        <Tabs
          options={[
            { id: "own" as const, label: "Their trades" },
            { id: "copied" as const, label: "Trades copying them" },
          ]}
          value={tab}
          onChange={(v) => setTab(v as "own" | "copied")}
        />

        {!isDeployed ? (
          <NeedsContract what="this trader" />
        ) : tab === "own" ? (
          own.isPending ? (
            <SkeletonRows rows={4} height="h-12" />
          ) : !own.data?.length ? (
            <Empty title="No trades on WinCut yet" />
          ) : (
            <Card className="px-3 py-1">
              <TradeList trades={own.data} />
            </Card>
          )
        ) : copied.isPending ? (
          <SkeletonRows rows={4} height="h-12" />
        ) : !copied.data?.length ? (
          <Empty
            title="Nobody has copied them yet"
            hint="A trade lands here when somebody names this account on the buy that opens their position."
          />
        ) : (
          <Card className="px-3 py-1">
            <TradeList trades={copied.data} showWho />
          </Card>
        )}
      </section>
    </Page>
  );
}
