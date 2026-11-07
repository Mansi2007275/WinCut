"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect } from "react";
import type { Address } from "viem";
import { Badge, Button, Card, Chip, ErrorBox, Row, Skeleton } from "./ui";
import { ConnectCta, FaucetLink } from "./NetworkGate";
import {
  capDetail,
  maxTradeLabel,
  SLIPPAGE_BPS,
  useTrade,
  type Side,
  type Step,
  type TradeResult,
} from "./TradePanel";
import type { Coin } from "@/lib/data";
import { QUOTE } from "@/lib/chain";
import { setTradeOpen } from "@/lib/rpc";
import { coins as fmtCoins, short, usd } from "@/lib/format";

/**
 * The buy and sell sheets.
 *
 * A sheet rather than an inline panel because the numbers that matter on a
 * sell -- the basis, the profit and the fee that follows from them -- need the
 * whole screen to be read in one go, and because committing money should feel
 * like a deliberate step away from browsing.
 */
export function TradeSheet({
  open,
  side,
  coin,
  follow,
  referrer,
  onClose,
  onResult,
}: {
  open: boolean;
  side: Side;
  coin: Coin;
  follow?: Address;
  referrer?: Address;
  onClose: () => void;
  onResult: (r: TradeResult) => void;
}) {
  // The screen polls several reads every 5s. That is the same endpoint the
  // gas estimate needs, and it is what tips Arc's limiter over at the exact
  // moment it matters most, so the fast polls are held while the sheet is up.
  useEffect(() => {
    setTradeOpen(open);
    return () => setTradeOpen(false);
  }, [open]);

  // Escape closes, and the page behind must not scroll under the sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label={`${side === "buy" ? "Buy" : "Sell"} ${coin.symbol}`}
        >
          <motion.div
            className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-card border-t border-border bg-surface"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 420, damping: 38 }}
            onClick={(e) => e.stopPropagation()}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragEnd={(_, info) => {
              // A flick down, or a drag past a third of the sheet, dismisses.
              if (info.offset.y > 140 || info.velocity.y > 600) onClose();
            }}
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="flex justify-center pt-2.5 pb-1">
              <span className="h-1 w-9 rounded-pill bg-border" />
            </div>
            <SheetBody
              side={side}
              coin={coin}
              follow={follow}
              referrer={referrer}
              onClose={onClose}
              onResult={onResult}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SheetBody({
  side,
  coin,
  follow,
  referrer,
  onClose,
  onResult,
}: {
  side: Side;
  coin: Coin;
  follow?: Address;
  referrer?: Address;
  onClose: () => void;
  onResult: (r: TradeResult) => void;
}) {
  const t = useTrade({ coin, side, follow, referrer, onResult });
  const isBuy = side === "buy";

  return (
    <div className="flex flex-col gap-3 px-4 pt-2 pb-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          {isBuy ? "Buy" : "Sell"} {coin.symbol}
        </h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className="tap w-10 text-lg text-secondary hover:text-text"
        >
          ✕
        </button>
      </div>

      {follow && isBuy && (
        <Badge tone="accent">
          Copying {short(follow)} — they earn 50% of the fee, and only if you profit
        </Badge>
      )}

      {/* ------------------------------------------------------- amount */}
      <Card tone="elevated" className="p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-secondary">{isBuy ? "You pay" : "You sell"}</span>
          <span className="num text-[11px] text-secondary">
            {isBuy ? (
              <>Fee on buys $0</>
            ) : (
              <>
                Holding {fmtCoins(t.balance)} {coin.symbol}
              </>
            )}
          </span>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          {isBuy && <span className="text-2xl font-semibold">$</span>}
          <input
            inputMode="decimal"
            value={t.amount}
            onChange={(e) => t.setAmount(e.target.value)}
            placeholder="0"
            aria-label={isBuy ? `Amount in ${QUOTE.symbol}` : "Percent of position"}
            className="num w-full min-w-0 border-0 bg-transparent text-[30px] font-semibold outline-none"
          />
          <span className="shrink-0 text-sm font-medium text-accent">
            {isBuy ? QUOTE.symbol : coin.symbol}
          </span>
        </div>
        {!isBuy && t.sellCoins > 0n && (
          <p className="num mt-1 text-[11px] text-secondary">
            selling {fmtCoins(t.sellCoins)} {coin.symbol}
          </p>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2">
          {(isBuy ? ["10", "50", "100"] : ["25", "50", "100"]).map((v) => (
            <Chip
              key={v}
              active={t.amount === v}
              onClick={() => t.setAmount(v)}
              className="justify-center text-center"
            >
              {isBuy ? `$${v}` : `${v}%`}
            </Chip>
          ))}
        </div>
      </Card>

      {/* -------------------------------------------------- buy preview */}
      {isBuy && t.amountQuote > 0n && (
        <Card className="p-4">
          {t.quoting && !t.quote ? (
            <>
              <Skeleton className="mb-2 h-4 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </>
          ) : t.quote?.coinsOut !== undefined ? (
            <>
              <Row
                label="You receive"
                value={`${fmtCoins(t.quote.coinsOut)} ${coin.symbol}`}
                strong
              />
              <Row label="Fee on buys" value={<span className="text-profit">$0.00</span>} />
              <p className="mt-2 text-[11px] leading-snug text-secondary">
                Quote from contract. Buys are never charged — the fee only applies when you exit
                at a profit.
              </p>
            </>
          ) : null}
        </Card>
      )}

      {/* ------------------------------------------------- sell preview */}
      {!isBuy && t.sellCoins > 0n && (
        <Card className="p-4">
          {t.quoting && !t.quote ? (
            <>
              <Skeleton className="mb-2 h-3 w-1/3" />
              <Skeleton className="mb-2 h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </>
          ) : t.quote ? (
            <>
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">Fee preview</p>
                <Badge>Quote from contract</Badge>
              </div>
              <Row label="Gross proceeds" value={usd(t.quote.grossOut)} />
              <Row label="Cost basis" value={usd(t.basis)} />
              {t.previewProfit !== undefined && (
                <Row
                  label="Your profit"
                  value={usd(t.previewProfit, { sign: true })}
                  tone={t.previewProfit >= 0n ? "profit" : "loss"}
                />
              )}
              <Row label="Loss credit used" value={usd(t.quote.lossCredit)} />

              <div className="my-2 border-t border-border" />

              <Row
                label="WinCut fee · 10% of profit"
                value={usd(t.quote.fee)}
                strong
                tone={t.quote.fee > 0n ? "text" : "profit"}
              />
              <Row label="A 0.5%-of-volume app" value={usd(t.quote.volumeFee)} tone="muted" />
              <Row
                label="If this were a loss"
                value={<span className="text-profit">$0.00</span>}
              />

              <div className="my-2 border-t border-border" />

              <Row label="You receive" value={usd(t.quote.netOut)} strong />
            </>
          ) : null}
        </Card>
      )}

      {/* ---------------------------------------------- route + minOut */}
      {!isBuy && t.quote && (
        <Card className="p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-[11px] text-secondary">Route</span>
            <span className="text-[11px]">
              <span className="text-profit">Universal Router</span>
              <span className="text-secondary"> → </span>
              <span className="text-accent">v4 PoolManager</span>
              <span className="text-secondary"> → </span>
              <span className="text-profit">WinCut hook</span>
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-[11px] text-secondary">
              Min received ({SLIPPAGE_BPS / 100}% slippage on net)
            </span>
            <span className="num text-[11px]">{usd(t.minOut)}</span>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------- steps */}
      {!isBuy && <Steps done={t.done} current={t.step} />}

      {t.overLimit && (
        <ErrorBox title={maxTradeLabel(t.cap)} detail={capDetail(side, t.tradeQuoteSide)} />
      )}

      {/* A throttled RPC is not a failed trade. viem wraps Arc's -32005 in a
          ContractFunctionExecutionError, so the raw text claims the contract
          reverted -- which is the opposite of the truth and sends people off
          debugging a swap that was never submitted. */}
      {t.retrying && (
        <Card tone="accent" className="px-3 py-2">
          <p className="text-xs leading-snug text-accent">Arc&apos;s RPC is busy. Retrying…</p>
        </Card>
      )}

      {t.error && !t.overLimit && !t.retrying && (
        <ErrorBox
          title={t.rateLimited ? "Arc's RPC is rate limiting right now" : "Quote or transaction failed"}
          detail={
            t.rateLimited
              ? "Wait a minute and try again, or switch your wallet's Arc RPC to https://rpc.drpc.testnet.arc.io."
              : t.error
          }
        />
      )}

      {/* ----------------------------------------------------- confirm */}
      {t.isConnected ? (
        <Button
          tone={isBuy ? "profit" : "accent"}
          className="w-full py-3.5 text-base"
          disabled={!t.canSubmit}
          onClick={() => void t.submit()}
        >
          {t.busy ? "Confirming…" : isBuy ? `Confirm buy` : `Confirm sell`}
        </Button>
      ) : (
        <ConnectCta label={`Connect to ${side} ${coin.symbol}`} />
      )}

      {isBuy && <FaucetLink className="self-start text-xs" />}
    </div>
  );
}

/// The three signatures a sell needs. Shown up front so nobody is surprised by
/// a second or third wallet prompt halfway through.
function Steps({ done, current }: { done: Step[]; current: Step | null }) {
  const steps: { id: Step; label: string }[] = [
    { id: "approve", label: "Approve" },
    { id: "permit", label: "Permit2" },
    { id: "sell", label: "Sell" },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {steps.map((s, i) => {
        const isDone = done.includes(s.id);
        const isNow = current === s.id;
        return (
          <div
            key={s.id}
            className={`rounded-btn border px-2 py-1.5 text-center text-[11px] font-semibold ${
              isDone
                ? "border-profit/30 bg-profit/15 text-profit"
                : isNow
                  ? "border-accent/40 bg-accent/15 text-accent"
                  : "border-border bg-elevated text-secondary"
            }`}
          >
            {i + 1} · {s.label} {isDone ? "✓" : ""}
          </div>
        );
      })}
    </div>
  );
}
