"use client";

import { motion } from "framer-motion";
import { Card, Button, Row, AddressLink, TxLink, useCountUp } from "./ui";
import { usd, coins as fmtCoins } from "@/lib/format";
import type { TradeResult } from "./TradePanel";

/**
 * The payoff screen.
 *
 * Every figure here is decoded from the transaction receipt — Sold, FeeSplit,
 * LossCredited and CreditConsumed, as the hook emitted them. Nothing is
 * recomputed in JavaScript. The previous version derived the three cuts as
 * fee*50/100, fee*20/100 and the remainder, which meant the screen would have
 * kept showing a tidy 50/20/30 even if the contract had done something else,
 * and it hid that the treasury absorbs the rounding dust.
 */
export function Result({ result, onDone }: { result: TradeResult; onDone: () => void }) {
  if (result.unattributed) return <Unattributed result={result} onDone={onDone} />;
  if (result.side === "buy") return <BuyResult result={result} onDone={onDone} />;
  return <SellResult result={result} onDone={onDone} />;
}

function BuyResult({ result, onDone }: { result: TradeResult; onDone: () => void }) {
  const buy = result.buy;
  return (
    <>
      <Card tone="accent" className="p-6 text-center">
        <p className="font-display text-sm uppercase">Bought</p>
        <p className="money mt-2 animate-pop text-4xl">{fmtCoins(buy?.coins)}</p>
        <p className="money mt-1 text-sm">for {usd(buy?.cost)}</p>
        <p className="mt-3 text-xs font-bold">
          Nothing charged. WinCut only earns when you exit at a profit.
        </p>
      </Card>

      {(buy?.followed || buy?.referrer) && (
        <Card className="p-4">
          <p className="mb-1 font-display text-xs uppercase">Attribution recorded on chain</p>
          {buy?.followed && (
            <Row label="Copying" value={<AddressLink address={buy.followed} />} />
          )}
          {buy?.referrer && (
            <Row label="Referrer" value={<AddressLink address={buy.referrer} />} />
          )}
          <p className="mt-2 font-mono text-[10px] leading-snug text-muted">
            Both are stored by the hook now, so they get paid automatically when you exit in
            profit. Neither can be changed afterwards.
          </p>
        </Card>
      )}

      <Done hash={result.hash} onDone={onDone} />
    </>
  );
}

function SellResult({ result, onDone }: { result: TradeResult; onDone: () => void }) {
  const sell = result.sell;
  const fee = sell?.fee ?? 0n;
  const pnl = sell?.pnl ?? 0n;
  const won = fee > 0n;
  const shown = useCountUp(won ? (pnl > 0n ? pnl : 0n) : 0n);

  if (!won) {
    return (
      <>
        <Card tone="surface" className="p-6 text-center">
          <p className="font-display text-sm uppercase text-muted">
            {pnl < 0n ? "You sold at a loss" : "You sold flat"}
          </p>
          <p className="money mt-1 text-2xl text-[#d32f45]">{usd(pnl, { sign: true })}</p>

          <div className="my-4 border-t-3 border-ink" />

          <p className="font-display text-xs uppercase">WinCut took</p>
          <motion.p
            className="money text-6xl leading-none text-[#00a152]"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 18 }}
          >
            $0
          </motion.p>

          {sell?.lossCredited && (
            <div className="nb-sm mt-4 bg-info p-3 text-white">
              <p className="font-display text-xs uppercase">Loss credit banked</p>
              <p className="money text-xl">{usd(sell.lossCredited.loss)}</p>
              <p className="mt-1 text-[10px]">
                Total credit now {usd(sell.lossCredited.newCredit)}. Your next{" "}
                {usd(sell.lossCredited.newCredit)} of profit is free.
              </p>
            </div>
          )}

          <p className="mt-3 text-[11px] text-muted">
            A 0.5%-of-volume app would still have charged you on this trade.
          </p>
        </Card>
        <Done hash={result.hash} onDone={onDone} proceeds={sell?.proceeds} />
      </>
    );
  }

  const split = sell?.split;

  return (
    <>
      <Card tone="profit" className="p-6 text-center">
        <p className="font-display text-sm uppercase">You profited</p>
        <p className="money mt-1 text-5xl leading-none">{usd(shown, { sign: true })}</p>
        <p className="mt-2 font-mono text-xs">you keep {usd(pnl - fee)} of it</p>
      </Card>

      {sell?.creditConsumed && sell.creditConsumed.used > 0n && (
        <Card tone="accent" className="p-3 text-white">
          <Row label="Loss credit spent" value={usd(sell.creditConsumed.used)} />
          <Row label="Credit remaining" value={usd(sell.creditConsumed.remaining)} />
          <p className="mt-1 font-mono text-[10px] leading-snug">
            Your banked losses reduced this fee before it was charged.
          </p>
        </Card>
      )}

      <Card className="p-4">
        <p className="mb-2 font-display text-sm uppercase">Where the fee went</p>
        {split ? (
          <>
            <SplitRow
              label="Trader you copied"
              who={split.followed}
              value={split.traderCut}
              delay={0}
            />
            <SplitRow
              label="Your referrer"
              who={split.referrer}
              value={split.referrerCut}
              delay={0.1}
            />
            <SplitRow label="WinCut" value={split.treasuryCut} delay={0.2} />
            <div className="my-2 border-t-3 border-ink" />
            <Row label="Total fee" value={usd(fee)} strong />
            <p className="mt-2 font-mono text-[10px] leading-snug text-muted">
              Read from the FeeSplit event in this transaction, not computed here. Each share is
              claimable from the hook — nothing is pushed, so a blocked address can never break
              anyone else&apos;s trade.
            </p>
          </>
        ) : (
          <>
            <Row label="Total fee" value={usd(fee)} strong />
            <p className="mt-2 font-mono text-[10px] leading-snug text-muted">
              This transaction emitted no FeeSplit event, so the breakdown is not shown rather
              than guessed.
            </p>
          </>
        )}
      </Card>

      <Done hash={result.hash} onDone={onDone} proceeds={sell?.proceeds} />
    </>
  );
}

/**
 * The swap went through but the hook recorded nothing.
 *
 * This happens when the router is not trusted or msgSender() could not identify
 * the trader. Showing a blank profit screen would be misleading: the money
 * moved, but no position, attribution or fee exists.
 */
function Unattributed({ result, onDone }: { result: TradeResult; onDone: () => void }) {
  return (
    <>
      <Card tone="loss" className="p-5 text-white">
        <p className="font-display text-sm uppercase">Swap went through, unattributed</p>
        <p className="mt-2 text-xs leading-snug">
          The transaction succeeded, but WinCut&apos;s hook emitted no event for it, so no
          position, referrer or fee was recorded. That means the swap did not route through a
          trusted Universal Router, or the router could not report who sent it.
        </p>
      </Card>
      <Done hash={result.hash} onDone={onDone} />
    </>
  );
}

function SplitRow({
  label,
  who,
  value,
  delay,
}: {
  label: string;
  who?: string;
  value: bigint;
  delay: number;
}) {
  return (
    <motion.div
      className="flex items-center justify-between gap-2 py-1.5"
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.25 }}
    >
      <span className="min-w-0 text-sm text-muted">
        {label}
        {who && (
          <>
            {" "}
            <AddressLink address={who} tight className="text-[10px]" />
          </>
        )}
      </span>
      <span className="money shrink-0 text-base">{usd(value)}</span>
    </motion.div>
  );
}

function Done({
  hash,
  onDone,
  proceeds,
}: {
  hash: string;
  onDone: () => void;
  proceeds?: bigint;
}) {
  return (
    <>
      {proceeds !== undefined && (
        <Card className="p-3">
          <Row label="Proceeds credited" value={usd(proceeds)} />
        </Card>
      )}
      <div className="nb-sm bg-white p-3 text-center">
        <TxLink hash={hash}>{hash}</TxLink>
      </div>
      <Button onClick={onDone} tone="accent" className="w-full">
        Done
      </Button>
    </>
  );
}
