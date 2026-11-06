"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import Link from "next/link";
import { Page } from "@/components/Shell";
import {
  AddressLink,
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Row,
  SkeletonRows,
  TxLink,
} from "@/components/ui";
import { ConnectCta, FaucetLink } from "@/components/NetworkGate";
import { useToast } from "@/components/Toast";
import { useCoins, useAccountState, useTrades } from "@/lib/data";
import { addr, isDeployed } from "@/lib/chain";
import { winCutHookAbi } from "@/config/abis";
import { inviteLink } from "@/lib/referral";
import { reason } from "@/components/TradePanel";
import { usd, coins as fmtCoins, price as fmtPrice } from "@/lib/format";

export default function MePage() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { data: wallet } = useWalletClient();

  const acct = useAccountState(address);
  const coinsQ = useCoins();
  const trades = useTrades();

  const toast = useToast();
  const [status, setStatus] = useState<"idle" | "pending" | "confirmed" | "failed">("idle");
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  // Realised PnL and fees paid, from this wallet's own Sold events.
  const stats = useMemo(() => {
    if (!trades.data || !address) return undefined;
    const mine = trades.data.filter((t) => t.trader.toLowerCase() === address.toLowerCase());
    let realised = 0n, feesPaid = 0n, wins = 0, exits = 0, volume = 0n;
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
    const id = toast.push({ kind: "pending", title: "Claiming earnings", detail: "Approve in your wallet" });
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
      toast.update(id, { kind: "confirmed", title: "Earnings claimed", detail: undefined, hash: h });
      acct.refetch();
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

  return (
    <Page>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl uppercase leading-none">You</h1>
          <p className="mt-1 break-all font-mono text-xs">{address}</p>
          <p className="mt-1 flex gap-3">
            <AddressLink address={address} label="explorer ↗" className="text-[10px]" />
            <Link href={`/trader/${address}`} className="font-mono text-[10px] underline">
              public profile ↗
            </Link>
          </p>
        </div>
      </div>

      {acct.isLoading && <SkeletonRows rows={2} height="h-20" />}
      {acct.error && <ErrorBox title="Cannot read your account" detail={String(acct.error)} />}

      {/* ---- realised performance ---- */}
      {stats && (
        <Card tone={stats.realised >= 0n ? "profit" : "white"} className="p-4">
          <p className="font-display text-xs uppercase">Realised P&amp;L</p>
          <p
            className={`money text-3xl ${stats.realised >= 0n ? "" : "text-[#d32f45]"}`}
          >
            {usd(stats.realised, { sign: true })}
          </p>
          <div className="mt-2 border-t-3 border-ink pt-2">
            <Row label="Exits" value={String(stats.exits)} />
            <Row
              label="Win rate"
              value={stats.exits ? `${Math.round((stats.wins / stats.exits) * 100)}%` : "—"}
            />
            <Row label="Fees you paid WinCut" value={usd(stats.feesPaid)} />
            <Row label="A 0.5% app would have taken" value={usd(stats.volume * 50n / 10000n)} tone="muted" />
            <Row
              label="Saved by WinCut"
              value={usd(stats.saved, { sign: true })}
              strong
              tone={stats.saved >= 0n ? "profit" : "loss"}
            />
          </div>
        </Card>
      )}

      {/* ---- loss credit ---- */}
      <Card tone={(acct.data?.lossCredit ?? 0n) > 0n ? "info" : "white"} className="p-4">
        <p className={`font-display text-xs uppercase ${(acct.data?.lossCredit ?? 0n) > 0n ? "text-white" : ""}`}>
          Loss credit
        </p>
        <p className={`money text-2xl ${(acct.data?.lossCredit ?? 0n) > 0n ? "text-white" : ""}`}>
          {usd(acct.data?.lossCredit ?? 0n)}
        </p>
        <p className={`mt-1 text-[11px] ${(acct.data?.lossCredit ?? 0n) > 0n ? "text-white/85" : "text-muted"}`}>
          {(acct.data?.lossCredit ?? 0n) > 0n
            ? "Your next profit up to this amount is charged nothing."
            : "Losses bank a credit here that offsets future fees."}
        </p>
      </Card>

      {/* ---- claimable ---- */}
      <Card tone={(acct.data?.claimable ?? 0n) > 0n ? "brand" : "white"} className="p-4">
        <p className="font-display text-xs uppercase">Claimable earnings</p>
        <p className="money text-3xl">{usd(acct.data?.claimable ?? 0n)}</p>
        <p className="mt-1 text-[11px] text-ink/70">
          Read directly from the hook. Earned when people who copied you, or whom
          you referred, exit at a profit.
        </p>
        <Button
          onClick={claim}
          disabled={(acct.data?.claimable ?? 0n) === 0n || status === "pending"}
          tone="ink"
          className="mt-3 w-full"
        >
          {status === "pending" ? "Claiming…" : "Claim"}
        </Button>
      </Card>

      {error && <ErrorBox title="Claim failed" detail={error} />}
      {status === "confirmed" && hash && (
        <div className="nb-sm bg-white p-2 text-center">
          <TxLink hash={hash} />
        </div>
      )}

      {/* ---- invite ---- */}
      <Card className="p-4">
        <p className="font-display text-xs uppercase">Your invite link</p>
        <p className="mt-1 text-[11px] leading-snug text-muted">
          You earn 20% of the fee whenever someone you invited exits at a profit. If they lose,
          you earn nothing — there is no fee to split.
        </p>
        <Button tone="brand" className="mt-3 w-full" onClick={shareInvite}>
          {copied ? "Link copied" : "Copy invite link"}
        </Button>
        <p className="mt-2 break-all font-mono text-[10px] text-muted">{inviteLink(address)}</p>
      </Card>

      {/* ---- positions ---- */}
      <h2 className="mt-2 text-lg uppercase">Positions</h2>
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
    <Card className="p-4">
      <button className="flex w-full items-start justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
        <div>
          <p className="font-display text-base">{coin.symbol}</p>
          <p className="font-mono text-[10px] text-muted">{fmtCoins(amount)} held</p>
        </div>
        <div className="text-right">
          <p className="money text-lg">{usd(cost)}</p>
          <p className="text-[10px] text-muted">cost basis</p>
        </div>
      </button>

      {open && (
        <div className="mt-3 border-t-3 border-ink pt-2">
          <Row label="Amount" value={fmtCoins(amount)} />
          <Row label="Total cost" value={usd(cost)} />
          <Row label="Avg cost / coin" value={fmtPrice(Number(avg) / 1e18)} />
          <Badge>tracked by the hook</Badge>
          <p className="mt-2 font-mono text-[10px] leading-snug text-muted">
            Only coins bought through WinCut are tracked. Airdropped or transferred
            coins carry no basis and are never charged a fee.
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
