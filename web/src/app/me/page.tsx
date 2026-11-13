"use client";

/**
 * The user's own page: money in, money out, what is open, what is banked and
 * what has been earned.
 *
 * The deposit/withdraw pair is here rather than in the order panel because it
 * is a different kind of action - it moves money between the wallet and WinCut
 * rather than between USDC and a token - and mixing the two is how people
 * withdraw when they meant to sell.
 */

import { useMemo, useState } from "react";
import Link from "next/link";

import { Page } from "@/components/Shell";
import { ConnectCta, ContractNote, NeedsContract } from "@/components/Gate";
import { TradeList } from "@/components/TradeTabs";
import { BridgeDeposit } from "@/components/BridgeDeposit";
import { Card, Empty, Loading, SectionHeading, SkeletonRows, StatTile } from "@/components/ui";
import { useToast } from "@/components/Toast";
import {
  useClaimable,
  useInternalBalance,
  useLossCredit,
  useMyTrades,
  useNearBalance,
  usePositions,
  useRefreshAfterTrade,
  useRoute,
  useTokens,
  useWalletUsdc,
} from "@/lib/queries";
import { useWallet } from "@/lib/wallet";
import * as act from "@/lib/actions";
import { isRegisteredOn } from "@/lib/near";
import { quoteRoute } from "@/lib/rhea";
import { inviteLink } from "@/lib/referral";
import { USDC_DECIMALS, USDC_ID, isDeployed } from "@/lib/near";
import {
  price as fmtPrice,
  shortAccount,
  tokens as fmtTokens,
  toNumber,
  toRaw,
  usd,
  usdFromNumber,
} from "@/lib/format";
import type { PositionView } from "@/lib/contract";

export default function MePage() {
  const { accountId } = useWallet();

  const balance = useInternalBalance(accountId);
  const walletUsdc = useWalletUsdc(accountId);
  const nearBalance = useNearBalance(accountId);
  const credit = useLossCredit(accountId);
  const claimable = useClaimable(accountId);
  const positions = usePositions(accountId);
  const myTrades = useMyTrades(accountId, 100);

  if (!accountId) {
    return (
      <Page width="lg">
        <Card className="p-4 text-center">
          <h1 className="text-base font-semibold">Your WinCut account</h1>
          <p className="mx-auto mt-1.5 max-w-sm text-[11px] leading-relaxed text-secondary">
            Connect to see your USDC balance, open positions, banked loss credit and anything
            you have earned from people copying you.
          </p>
          <div className="mx-auto mt-3 max-w-xs">
            <ConnectCta />
          </div>
        </Card>
      </Page>
    );
  }

  return (
    <Page width="lg">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="num text-lg font-semibold">{shortAccount(accountId)}</h1>
        <Link
          href={`/trader/${encodeURIComponent(accountId)}`}
          className="text-[11px] text-accent underline-offset-2 hover:underline"
        >
          your public trader page →
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label="WinCut balance"
          value={balance.data === undefined ? "…" : usd(balance.data)}
          sub="spendable on trades"
        />
        <StatTile
          label="Loss credit"
          tone="accent"
          value={credit.data === undefined ? "…" : usd(credit.data)}
          sub="spent before any fee"
        />
        <StatTile
          label="Claimable"
          tone={claimable.data && claimable.data > 0n ? "profit" : "text"}
          value={claimable.data === undefined ? "…" : usd(claimable.data)}
          sub="copy + referral earnings"
        />
        <StatTile
          label="In your wallet"
          value={walletUsdc.data === undefined ? "…" : usd(walletUsdc.data)}
          sub={
            nearBalance.data === undefined
              ? "USDC"
              : `USDC · ${(Number(nearBalance.data) / 1e24).toFixed(2)} NEAR for gas`
          }
        />
      </div>

      <Money
        accountId={accountId}
        internal={balance.data ?? 0n}
        wallet={walletUsdc.data ?? 0n}
        claimable={claimable.data ?? 0n}
      />

      <BridgeDeposit />

      <section className="flex flex-col gap-2">
        <SectionHeading>Open positions</SectionHeading>
        {!isDeployed ? (
          <NeedsContract what="positions" />
        ) : positions.isPending ? (
          <SkeletonRows rows={2} height="h-16" />
        ) : positions.isError ? (
          <ErrorCard detail={(positions.error as Error).message} />
        ) : !positions.data?.length ? (
          <Empty
            title="Nothing open"
            hint="Buying costs no WinCut fee, so opening a position only ever costs Rhea's pool fee and gas."
          />
        ) : (
          <Card className="p-0">
            <ul className="flex flex-col divide-y divide-border">
              {positions.data.map((p) => (
                <li key={p.token_id}>
                  <PositionRow position={p} />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeading>Your trades</SectionHeading>
        {!isDeployed ? (
          <NeedsContract what="your trades" />
        ) : myTrades.isPending ? (
          <Loading label="Reading your trades" />
        ) : !myTrades.data?.length ? (
          <Empty title="No trades yet" hint="They appear here as soon as one settles on chain." />
        ) : (
          <Card className="px-3 py-1">
            <TradeList trades={myTrades.data} />
          </Card>
        )}
      </section>

      <Invite accountId={accountId} />
      <ContractNote />
    </Page>
  );
}

/* ----------------------------------------------------------- deposit flow */

function Money({
  accountId,
  internal,
  wallet,
  claimable,
}: {
  accountId: string;
  internal: bigint;
  wallet: bigint;
  claimable: bigint;
}) {
  const { sign, signBatch } = useWallet();
  const toast = useToast();
  const refresh = useRefreshAfterTrade(accountId);
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const raw = useMemo(() => toRaw(amount, USDC_DECIMALS), [amount]);
  const max = mode === "deposit" ? wallet : internal;
  const tooMuch = raw > max;

  async function run() {
    if (raw === 0n || tooMuch || busy) return;
    setBusy(true);
    const id = toast.push({
      kind: "pending",
      title: `${mode === "deposit" ? "Depositing" : "Withdrawing"} ${usd(raw)}`,
    });
    try {
      let hash: string;
      if (mode === "deposit") {
        hash = await sign(act.depositUsdc(raw));
      } else {
        // A withdrawal to an account with no USDC storage bounces, and WinCut
        // just puts the money back. Paying the 0.00125 NEAR first in the same
        // transaction turns a confusing round trip into one signature.
        const registered = await isRegisteredOn(USDC_ID, accountId);
        if (registered) {
          hash = await sign(act.withdrawUsdc(raw));
        } else {
          await sign(act.registerSelfOnUsdc(accountId));
          hash = await sign(act.withdrawUsdc(raw));
        }
      }
      toast.update(id, {
        kind: "confirmed",
        title: mode === "deposit" ? `Deposited ${usd(raw)}` : `Withdrew ${usd(raw)}`,
        hash,
      });
      setAmount("");
      refresh();
    } catch (e) {
      toast.update(id, {
        kind: "failed",
        title: mode === "deposit" ? "Deposit failed" : "Withdrawal failed",
        detail: (e as Error).message?.slice(0, 220),
      });
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    setBusy(true);
    const id = toast.push({ kind: "pending", title: `Claiming ${usd(claimable)}` });
    try {
      const hash = await sign(act.claimEarnings());
      toast.update(id, { kind: "confirmed", title: `Claimed ${usd(claimable)}`, hash });
      refresh();
    } catch (e) {
      toast.update(id, {
        kind: "failed",
        title: "Claim failed",
        detail: (e as Error).message?.slice(0, 220),
      });
    } finally {
      setBusy(false);
    }
  }

  // `signBatch` is used for nothing here yet; referenced so the shape stays
  // available to callers that need a multi-action transaction.
  void signBatch;

  return (
    <Card className="p-3">
      <div className="flex gap-1.5">
        {(["deposit", "withdraw"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setAmount("");
            }}
            className={`flex-1 rounded-btn py-1.5 text-xs font-semibold capitalize transition-colors ${
              mode === m ? "bg-elevated text-text" : "text-secondary hover:text-text"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="mt-2.5 flex items-center gap-2 rounded-btn border border-border bg-bg px-3 py-2 focus-within:border-accent">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          inputMode="decimal"
          placeholder="0.00"
          aria-label={`Amount to ${mode}`}
          className="num min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none placeholder:text-secondary"
        />
        <button
          type="button"
          onClick={() => setAmount(toNumber(max, USDC_DECIMALS).toString())}
          className="shrink-0 rounded-pill border border-border px-2 py-0.5 text-[10px] text-secondary hover:text-text"
        >
          max
        </button>
        <span className="shrink-0 text-xs font-medium text-secondary">USDC</span>
      </div>

      <p className="mt-1.5 text-[10px] text-secondary">
        {mode === "deposit"
          ? `In your wallet: ${usd(wallet)}. Deposited USDC can be traded with no per-swap approval.`
          : `Inside WinCut: ${usd(internal)}. Withdrawals need a wallet signature, every time.`}
      </p>
      {tooMuch && <p className="mt-1 text-[11px] text-loss">More than you have.</p>}

      <button
        type="button"
        onClick={() => void run()}
        disabled={raw === 0n || tooMuch || busy || !isDeployed}
        className="tap mt-2.5 w-full rounded-btn bg-accent py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
      >
        {busy ? "Signing…" : mode === "deposit" ? "Deposit USDC" : "Withdraw USDC"}
      </button>

      {claimable > 0n && (
        <button
          type="button"
          onClick={() => void claim()}
          disabled={busy}
          className="tap mt-2 w-full rounded-btn border border-profit/40 bg-profit-dim py-2.5 text-sm font-semibold text-profit transition-colors hover:bg-profit/20 disabled:opacity-40"
        >
          Claim {usd(claimable)} earned
        </button>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- positions */

function PositionRow({ position }: { position: PositionView }) {
  const tokens = useTokens();
  const token = tokens.data?.find((t) => t.token_id === position.token_id);
  const route = useRoute(token);

  const amount = BigInt(position.amount);
  const basis = BigInt(position.cost_basis_usdc);
  const entry = toNumber(basis, USDC_DECIMALS) / toNumber(amount, position.decimals);

  const nowWorth = route.data ? quoteRoute(amount, route.data.sell) : undefined;
  const pnl = nowWorth === undefined ? undefined : nowWorth - basis;
  const pnlPct =
    pnl === undefined || basis === 0n ? undefined : (Number(pnl) / Number(basis)) * 100;

  return (
    <Link
      href={`/trade/${encodeURIComponent(position.token_id)}`}
      className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-elevated"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">{position.symbol || shortAccount(position.token_id)}</p>
        <p className="num mt-0.5 text-[10px] text-secondary">
          {fmtTokens(amount, position.decimals)} · entry {fmtPrice(entry)}
          {position.followed && ` · copying ${shortAccount(position.followed)}`}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="num text-[13px] font-medium">
          {nowWorth === undefined ? "…" : usd(nowWorth)}
        </p>
        <p
          className={`num text-[10px] ${
            pnl === undefined ? "text-secondary" : pnl >= 0n ? "text-profit" : "text-loss"
          }`}
        >
          {pnl === undefined
            ? `cost ${usd(basis)}`
            : `${usdFromNumber(toNumber(pnl, USDC_DECIMALS), { sign: true })}${
                pnlPct !== undefined ? ` (${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}%)` : ""
              }`}
        </p>
      </div>
    </Link>
  );
}

/* ----------------------------------------------------------------- invite */

function Invite({ accountId }: { accountId: string }) {
  const [copied, setCopied] = useState(false);
  const link = inviteLink(accountId);

  return (
    <Card className="p-3">
      <SectionHeading>Your invite link</SectionHeading>
      <p className="mt-1 text-[11px] leading-relaxed text-secondary">
        You earn 20% of the WinCut fee from anyone who arrives through this link - and only on the
        trades they close in profit. If they lose, you earn nothing, because there is no fee to
        share.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-btn border border-border bg-bg px-3 py-2 text-[11px] text-secondary">
          {link || "…"}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
          className="tap shrink-0 rounded-btn border border-border bg-surface px-3 py-2 text-[11px] font-medium hover:bg-elevated"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
    </Card>
  );
}

function ErrorCard({ detail }: { detail: string }) {
  return (
    <Card tone="loss" className="p-3">
      <p className="text-xs font-semibold text-loss">Could not read the contract</p>
      <p className="mt-1 text-[11px] break-words text-secondary">{detail}</p>
    </Card>
  );
}
