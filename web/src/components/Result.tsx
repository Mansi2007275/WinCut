"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import { AddressLink, Avatar, Button, Card, Row, SplitBar, TxLink } from "./ui";
import { usd, coins as fmtCoins } from "@/lib/format";
import { deployed, explorerTx } from "@/lib/chain";
import type { TradeResult } from "./TradePanel";

/**
 * The payoff screen.
 *
 * Every figure here is decoded from the transaction receipt -- Sold, FeeSplit,
 * LossCredited and CreditConsumed, as the hook emitted them. Nothing is
 * recomputed in JavaScript. An earlier version derived the three cuts as
 * fee*50/100, fee*20/100 and the remainder, which meant the screen would have
 * kept showing a tidy 50/20/30 even if the contract had done something else,
 * and it hid that the treasury absorbs the rounding dust.
 */
export function Result({ result, onDone }: { result: TradeResult; onDone: () => void }) {
  if (result.unattributed) return <Unattributed result={result} onDone={onDone} />;
  if (result.side === "buy") return <BuyResult result={result} onDone={onDone} />;
  return <SellResult result={result} onDone={onDone} />;
}

function Confirmed() {
  return (
    <Card tone="profit" className="px-4 py-2.5">
      <p className="text-sm font-semibold text-profit">✓ Confirmed on {deployed.chainName}</p>
    </Card>
  );
}

function BuyResult({ result, onDone }: { result: TradeResult; onDone: () => void }) {
  const buy = result.buy;
  return (
    <>
      <Confirmed />

      <Card className="p-6 text-center">
        <p className="text-xs text-secondary">You bought</p>
        <motion.p
          className="num mt-1.5 text-[34px] leading-none font-semibold"
          initial={{ scale: 0.94, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 320, damping: 22 }}
        >
          {fmtCoins(buy?.coins)}
        </motion.p>
        <p className="num mt-1.5 text-sm text-secondary">for {usd(buy?.cost)}</p>
        <p className="mt-3 text-xs leading-snug text-profit">
          Nothing charged. WinCut only earns when you exit at a profit.
        </p>
      </Card>

      {(buy?.followed || buy?.referrer) && (
        <Card className="p-4">
          <p className="mb-1 text-sm font-semibold">Attribution recorded on chain</p>
          {buy?.followed && <Row label="Copying" value={<AddressLink address={buy.followed} />} />}
          {buy?.referrer && <Row label="Referrer" value={<AddressLink address={buy.referrer} />} />}
          <p className="mt-2 text-[11px] leading-snug text-secondary">
            Both are stored by the hook now, so they get paid automatically when you exit in
            profit. Neither can be changed afterwards.
          </p>
        </Card>
      )}

      <Done hash={result.hash} onDone={onDone} shareText={shareBuy(buy?.coins, buy?.cost)} />
    </>
  );
}

function SellResult({ result, onDone }: { result: TradeResult; onDone: () => void }) {
  const sell = result.sell;
  const fee = sell?.fee ?? 0n;
  const pnl = sell?.pnl ?? 0n;
  const won = fee > 0n;
  const split = sell?.split;

  if (!won) {
    return (
      <>
        <Confirmed />

        <Card className="p-6 text-center">
          <p className="text-xs text-secondary">
            {pnl < 0n ? "You sold at a loss" : "You sold flat"}
          </p>
          <p className="num mt-1 text-xl font-semibold text-loss">{usd(pnl, { sign: true })}</p>

          <div className="my-4 border-t border-border" />

          <p className="text-xs text-secondary">WinCut took</p>
          <motion.p
            className="num text-[52px] leading-none font-semibold text-profit"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
          >
            $0
          </motion.p>

          {sell?.lossCredited && (
            <Card tone="accent" className="mt-4 p-3 text-left">
              <p className="text-xs font-semibold text-accent">Loss credit banked</p>
              <p className="num mt-0.5 text-lg font-semibold">
                {usd(sell.lossCredited.loss)}
              </p>
              <p className="mt-1 text-[11px] leading-snug text-secondary">
                Total credit now {usd(sell.lossCredited.newCredit)}. Your next{" "}
                {usd(sell.lossCredited.newCredit)} of profit is free.
              </p>
            </Card>
          )}

          <p className="mt-3 text-[11px] text-secondary">
            A 0.5%-of-volume app would still have charged you on this trade.
          </p>
        </Card>

        <Settled hash={result.hash} />
        <Done
          hash={result.hash}
          onDone={onDone}
          proceeds={sell?.proceeds}
          shareText={shareLoss(pnl, sell?.lossCredited?.loss)}
        />
      </>
    );
  }

  return (
    <>
      <Confirmed />

      <Card className="p-6 text-center">
        <p className="text-xs text-secondary">
          You sold {fmtCoins(sell?.coins)}
        </p>
        <motion.p
          className="num mt-1.5 text-[44px] leading-none font-semibold text-profit"
          initial={{ scale: 0.92, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
        >
          {usd(pnl, { sign: true })}
        </motion.p>
        <p className="num mt-1.5 text-xs text-secondary">
          realised profit · you received {usd(sell?.proceeds)}
        </p>
      </Card>

      {sell?.creditConsumed && sell.creditConsumed.used > 0n && (
        <Card tone="accent" className="p-3">
          <Row label="Loss credit spent" value={usd(sell.creditConsumed.used)} />
          <Row label="Credit remaining" value={usd(sell.creditConsumed.remaining)} />
          <p className="mt-1 text-[11px] leading-snug text-secondary">
            Your banked losses reduced this fee before it was charged.
          </p>
        </Card>
      )}

      <Card className="p-4">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-semibold">WinCut fee</p>
          <p className="num text-sm font-semibold">{usd(fee)}</p>
        </div>
        <p className="mt-0.5 text-[11px] text-secondary">
          10% of profit, taken by the hook in afterSwap
        </p>

        {split ? (
          <>
            <div className="my-3">
              <SplitBar
                parts={[
                  { value: split.traderCut, className: "bg-accent" },
                  { value: split.referrerCut, className: "bg-accent/55" },
                  { value: split.treasuryCut, className: "bg-secondary/60" },
                ]}
              />
            </div>
            <SplitRow
              dot="bg-accent"
              label="Trader you copied"
              who={split.followed}
              value={split.traderCut}
              total={fee}
              delay={0}
            />
            <SplitRow
              dot="bg-accent/55"
              label="Your referrer"
              who={split.referrer}
              value={split.referrerCut}
              total={fee}
              delay={0.08}
            />
            <SplitRow
              dot="bg-secondary/60"
              label="WinCut"
              value={split.treasuryCut}
              total={fee}
              delay={0.16}
            />
            <p className="mt-2 text-[11px] leading-snug text-secondary">
              Read from this transaction&apos;s Sold and FeeSplit events, not computed here. Each
              share is claimable from the hook — nothing is pushed, so a blocked address can never
              break anyone else&apos;s trade.
            </p>
          </>
        ) : (
          <p className="mt-2 text-[11px] leading-snug text-secondary">
            This transaction emitted no FeeSplit event, so the breakdown is not shown rather than
            guessed.
          </p>
        )}
      </Card>

      <Settled hash={result.hash} />
      <Done
        hash={result.hash}
        onDone={onDone}
        proceeds={sell?.proceeds}
        shareText={shareWin(pnl, fee)}
      />
    </>
  );
}

/**
 * The swap went through but the hook recorded nothing.
 *
 * This happens when the router is not trusted or msgSender() could not
 * identify the trader. Showing a blank profit screen would be misleading: the
 * money moved, but no position, attribution or fee exists.
 */
function Unattributed({ result, onDone }: { result: TradeResult; onDone: () => void }) {
  return (
    <>
      <Card tone="loss" className="p-5">
        <p className="text-sm font-semibold text-loss">Swap went through, unattributed</p>
        <p className="mt-2 text-xs leading-snug text-text/80">
          The transaction succeeded, but WinCut&apos;s hook emitted no event for it, so no
          position, referrer or fee was recorded. That means the swap did not route through a
          trusted Universal Router, or the router could not report who sent it.
        </p>
      </Card>
      <Done hash={result.hash} onDone={onDone} />
    </>
  );
}

function Settled({ hash }: { hash: string }) {
  return (
    <Card className="flex items-center justify-between gap-3 p-3">
      <span className="text-[11px] leading-snug text-secondary">
        Settled by Uniswap v4 PoolManager
      </span>
      <TxLink hash={hash}>
        {hash.slice(0, 6)}…{hash.slice(-4)} ↗
      </TxLink>
    </Card>
  );
}

function SplitRow({
  dot,
  label,
  who,
  value,
  total,
  delay,
}: {
  dot: string;
  label: string;
  who?: string;
  value: bigint;
  total: bigint;
  delay: number;
}) {
  // The percentage is derived from the actual cuts, so a rounding remainder in
  // the treasury share shows up instead of being rounded back to a tidy 30%.
  const pct = total > 0n ? (Number(value) / Number(total)) * 100 : 0;
  return (
    <motion.div
      className="flex items-start justify-between gap-3 py-1.5"
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.22 }}
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-[3px] ${dot}`} />
        <span className="min-w-0">
          <span className="block text-sm">
            {label} · <span className="num text-secondary">{pct.toFixed(0)}%</span>
          </span>
          {who && (
            <span className="num mt-0.5 flex items-center gap-1.5 text-[11px] text-secondary">
              <Avatar address={who} size={16} />
              <AddressLink address={who} tight />
            </span>
          )}
        </span>
      </span>
      <span className="num shrink-0 text-sm font-semibold">{usd(value, { decimals: 3 })}</span>
    </motion.div>
  );
}

/* --------------------------------------------------------------- sharing */

const shareWin = (pnl: bigint, fee: bigint) =>
  `I made ${usd(pnl)} on WinCut and paid ${usd(fee)} — 10% of the profit, nothing else.`;
const shareLoss = (pnl: bigint, credit?: bigint) =>
  credit
    ? `I lost ${usd(pnl < 0n ? -pnl : pnl)} on WinCut and paid $0. It banked a ${usd(credit)} loss credit against my next win.`
    : `I exited at a loss on WinCut and paid $0 in fees.`;
const shareBuy = (coins?: bigint, cost?: bigint) =>
  `Bought ${fmtCoins(coins)} on WinCut for ${usd(cost)}. No fee on buys.`;

function Done({
  hash,
  onDone,
  proceeds,
  shareText,
}: {
  hash: string;
  onDone: () => void;
  proceeds?: bigint;
  shareText?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const text = `${shareText ?? "My WinCut trade"} ${explorerTx(hash)}`;
    try {
      // The Web Share sheet where the browser has one; clipboard everywhere
      // else, which is every desktop browser this will be demoed in.
      if (navigator.share) {
        await navigator.share({ text });
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // The user dismissed the share sheet, or the clipboard is blocked.
      // Neither is worth an error on a receipt screen.
    }
  }

  return (
    <>
      {proceeds !== undefined && (
        <Card className="p-3">
          <Row label="Proceeds credited" value={usd(proceeds)} />
        </Card>
      )}
      <div className="flex gap-2">
        <Button tone="elevated" className="flex-1 py-3.5 text-base" onClick={() => void share()}>
          {copied ? "Copied ✓" : "Share"}
        </Button>
        <Button className="flex-1 py-3.5 text-base" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  );
}
