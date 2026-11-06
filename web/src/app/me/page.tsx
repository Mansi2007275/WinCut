"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useBalance, usePublicClient, useWalletClient } from "wagmi";
import Link from "next/link";
import { Page } from "@/components/Shell";
import {
  AddressLink,
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Money,
  Row,
  SectionHeading,
  SkeletonRows,
  TxLink,
} from "@/components/ui";
import { ConnectCta, FaucetLink } from "@/components/NetworkGate";
import { useToast } from "@/components/Toast";
import { useAccountState, useCoins, useEarnings, useTrades } from "@/lib/data";
import { addr, isDeployed, QUOTE } from "@/lib/chain";
import { winCutHookAbi } from "@/config/abis";
import { inviteLink } from "@/lib/referral";
import { reason } from "@/components/TradePanel";
import { usd, coins as fmtCoins, price as fmtPrice, short } from "@/lib/format";

export default function MePage() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();
  const { data: bal } = useBalance({ address });

  const acct = useAccountState(address);
  const coinsQ = useCoins();
  const trades = useTrades();
  const earnings = useEarnings(address);

  const toast = useToast();
  const [status, setStatus] = useState<"idle" | "pending" | "confirmed" | "failed">("idle");
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  // Realised PnL and fees paid, from this wallet's own Sold events.
  const stats = useMemo(() => {
    if (!trades.data || !address) return undefined;
    const mine = trades.data.filter((t) => t.trader.toLowerCase() === address.toLowerCase());
    let realised = 0n,
      feesPaid = 0n,
      wins = 0,
      exits = 0,
      volume = 0n;
    for (const t of mine) {
      if (t.kind !== "sell") continue;
      exits += 1;
      realised += t.pnl ?? 0n;
      feesPaid += t.fee ?? 0n;
      volume += t.quoteAmount;
      if ((t.pnl ?? 0n) > 0n) wins += 1;
    }
    // What a conventional 0.5%-of-volume app would have taken instead.
    const wouldHavePaid = (volume * 50n) / 10_000n;
    return { realised, feesPaid, wins, exits, volume, saved: wouldHavePaid - feesPaid };
  }, [trades.data, address]);

  async function claim() {
    if (!wallet || !client) return;
    setStatus("pending");
    setError(undefined);
    const id = toast.push({
      kind: "pending",
      title: "Claiming earnings",
      detail: "Approve in your wallet",
    });
    try {
      const h = await wallet.writeContract({
        address: addr.hook,
        abi: winCutHookAbi,
        functionName: "claim",
        chain: wallet.chain,
        account: wallet.account,
      });
      setHash(h);
      toast.update(id, { detail: "Waiting for the block", hash: h });
      const r = await client.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error("claim reverted");
      setStatus("confirmed");
      toast.update(id, {
        kind: "confirmed",
        title: "Earnings claimed",
        detail: undefined,
        hash: h,
      });
      acct.refetch();
      earnings.refetch();
    } catch (e) {
      setStatus("failed");
      const msg = reason(e);
      setError(msg);
      toast.update(id, { kind: "failed", title: "Claim failed", detail: msg });
    }
  }

  async function shareInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink(address));
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be denied; the link is printed below regardless.
      setCopied(false);
    }
  }

  if (!isConnected)
    return (
      <Page>
        <Empty
          title="Connect your wallet"
          hint="Your positions, loss credit and earnings live here. Nothing is stored off chain — this screen is just a view of the hook."
        />
        <ConnectCta />
      </Page>
    );

  const claimable = acct.data?.claimable ?? 0n;
  const credit = acct.data?.lossCredit ?? 0n;

  return (
    <Page>
      {/* -------------------------------------------------- portfolio */}
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <Avatar address={address} size={40} />
          <div className="min-w-0 flex-1">
            <p className="num truncate text-sm font-semibold">{short(address)}</p>
            <p className="mt-0.5 flex gap-3 text-[11px]">
              <AddressLink address={address} label="explorer ↗" />
              <Link
                href={`/trader/${address}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                public profile ↗
              </Link>
            </p>
          </div>
        </div>
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs text-secondary">Cash · {QUOTE.symbol}</p>
          <p className="num mt-1 text-[28px] leading-none font-semibold">
            <Money value={bal?.value} />
          </p>
        </div>
      </Card>

      {acct.isLoading && <SkeletonRows rows={2} height="h-20" />}
      {acct.error && <ErrorBox title="Cannot read your account" detail={String(acct.error)} />}

      {/* ------------------------------------------ realised performance */}
      {stats && (
        <Card className="p-4">
          <p className="text-xs text-secondary">Realised P&amp;L</p>
          <p
            className={`num mt-1 text-[28px] leading-none font-semibold ${
              stats.realised > 0n ? "text-profit" : stats.realised < 0n ? "text-loss" : "text-text"
            }`}
          >
            {usd(stats.realised, { sign: true })}
          </p>
          <div className="mt-3 border-t border-border pt-2">
            <Row label="Exits" value={String(stats.exits)} />
            <Row
              label="Win rate"
              value={stats.exits ? `${Math.round((stats.wins / stats.exits) * 100)}%` : "—"}
            />
            <Row label="Fees you paid WinCut" value={usd(stats.feesPaid)} />
            <Row
              label="A 0.5% app would have taken"
              value={usd((stats.volume * 50n) / 10_000n)}
              tone="muted"
            />
            <Row
              label="Saved by WinCut"
              value={usd(stats.saved, { sign: true })}
              strong
              tone={stats.saved >= 0n ? "profit" : "loss"}
            />
          </div>
        </Card>
      )}

      {/* ------------------------------------------------- loss credit */}
      <Card tone={credit > 0n ? "accent" : "surface"} className="p-4">
        <p className={`text-xs ${credit > 0n ? "text-accent" : "text-secondary"}`}>Loss credit</p>
        <p className="num mt-1 text-2xl font-semibold">{usd(credit)}</p>
        <p className="mt-1 text-[11px] leading-snug text-secondary">
          {credit > 0n
            ? "Your next profit up to this amount is charged nothing."
            : "Losses bank a credit here that offsets future fees."}
        </p>
      </Card>

      {/* --------------------------------------------------- claimable */}
      <Card tone={claimable > 0n ? "profit" : "surface"} className="p-4">
        <p className={`text-xs ${claimable > 0n ? "text-profit" : "text-secondary"}`}>
          Claimable earnings
        </p>
        <p className="num mt-1 text-[28px] leading-none font-semibold">{usd(claimable)}</p>
        <p className="mt-1.5 text-[11px] leading-snug text-secondary">
          Read directly from the hook. Earned when people who copied you, or whom you referred,
          exit at a profit.
        </p>
        {earnings.data && earnings.data.total > 0n && (
          <p className="num mt-1 text-[11px] text-secondary">
            Paid to you in total so far: {usd(earnings.data.total)} across {earnings.data.payouts}{" "}
            exit{earnings.data.payouts === 1 ? "" : "s"}.
          </p>
        )}
        <Button
          onClick={claim}
          disabled={claimable === 0n || status === "pending"}
          className="mt-3 w-full"
        >
          {status === "pending" ? "Claiming…" : "Claim"}
        </Button>
      </Card>

      {error && <ErrorBox title="Claim failed" detail={error} />}
      {status === "confirmed" && hash && (
        <Card className="p-2 text-center">
          <TxLink hash={hash}>View the claim on the explorer ↗</TxLink>
        </Card>
      )}

      {/* ------------------------------------------------------ invite */}
      <Card className="p-4">
        <p className="text-sm font-semibold">Your invite link</p>
        <p className="mt-1 text-[11px] leading-snug text-secondary">
          You earn 20% of the fee whenever someone you invited exits at a profit. If they lose,
          you earn nothing — there is no fee to split.
        </p>
        <Button tone="elevated" className="mt-3 w-full" onClick={shareInvite}>
          {copied ? "Link copied ✓" : "Copy invite link"}
        </Button>
        <p className="mt-2 text-[11px] break-all text-secondary">{inviteLink(address)}</p>
      </Card>

      {/* --------------------------------------------------- positions */}
      <section className="flex flex-col gap-2">
        <SectionHeading>Positions</SectionHeading>
        {coinsQ.isLoading && <SkeletonRows rows={2} height="h-20" />}
        {coinsQ.data?.map((c) => (
          <PositionCard key={c.address} coin={c} account={address!} />
        ))}
        {isDeployed && coinsQ.data?.length === 0 && (
          <Empty
            title="No coins yet. Be the first."
            hint="Launch one and your position shows up here."
          />
        )}
      </section>

      <div className="flex justify-center">
        <FaucetLink />
      </div>
    </Page>
  );
}

function PositionCard({
  coin,
  account,
}: {
  coin: { address: `0x${string}`; symbol: string; poolId: `0x${string}` };
  account: `0x${string}`;
}) {
  const [open, setOpen] = useState(false);

  const q = useAccountPosition(coin.poolId, account);
  if (!q.data || q.data.amount === 0n) return null;

  const { amount, cost } = q.data;
  const avg = amount > 0n ? (cost * 10n ** 18n) / amount : 0n;

  return (
    <Card className="p-3">
      <button
        className="tap flex w-full items-center gap-3 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Avatar address={coin.address} size={32} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{coin.symbol}</p>
          <p className="num mt-0.5 text-[11px] text-secondary">{fmtCoins(amount)} held</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="num text-sm font-semibold">{usd(cost)}</p>
          <p className="text-[10px] text-secondary">cost basis</p>
        </div>
        <span className="shrink-0 text-secondary">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="mt-3 border-t border-border pt-2">
          <Row label="Amount" value={fmtCoins(amount)} />
          <Row label="Total cost" value={usd(cost)} />
          <Row label="Avg cost / coin" value={fmtPrice(Number(avg) / 1e18)} />
          <div className="mt-2 flex items-center gap-2">
            <Badge>tracked by the hook</Badge>
            <Link
              href={`/coin/${coin.address}`}
              className="text-[11px] text-accent underline-offset-2 hover:underline"
            >
              Trade ↗
            </Link>
          </div>
          <p className="mt-2 text-[11px] leading-snug text-secondary">
            Only coins bought through WinCut are tracked. Airdropped or transferred coins carry no
            basis and are never charged a fee.
          </p>
        </div>
      )}
    </Card>
  );
}

/// Small local hook so each position card reads its own slice.
function useAccountPosition(poolId: `0x${string}`, account: `0x${string}`) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["pos", poolId, account],
    enabled: !!client,
    refetchInterval: 6_000,
    queryFn: async () => {
      const [amount, cost] = await client!.readContract({
        address: addr.hook,
        abi: winCutHookAbi,
        functionName: "positionOf",
        args: [account, poolId],
      });
      return { amount, cost };
    },
  });
}
