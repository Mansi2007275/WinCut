"use client";

import { useEffect, useState } from "react";
import { Card, Button, Row } from "./ui";
import { usd, coins as fmtCoins } from "@/lib/format";
import { deployed } from "@/lib/chain";

/// The payoff screen. A profit animates the split going to the three
/// recipients; a loss shows a large $0 and the credit banked.
export function Result({
  side,
  pnl,
  fee,
  credit,
  received,
  hash,
  onDone,
}: {
  side: "buy" | "sell";
  pnl?: bigint;
  fee?: bigint;
  credit?: bigint;
  received?: bigint;
  hash: `0x${string}`;
  onDone: () => void;
}) {
  const isSell = side === "sell";
  const won = isSell && (fee ?? 0n) > 0n;
  const lost = isSell && !won;

  const traderCut = ((fee ?? 0n) * 50n) / 100n;
  const referrerCut = ((fee ?? 0n) * 20n) / 100n;
  const appCut = (fee ?? 0n) - traderCut - referrerCut;

  const shown = useCountUp(won ? (pnl ?? 0n) : 0n);

  if (!isSell) {
    return (
      <>
        <Card tone="brand" className="p-6 text-center">
          <p className="font-display text-sm uppercase">Bought</p>
          <p className="money mt-2 animate-pop text-4xl">{fmtCoins(received)}</p>
          <p className="mt-2 text-xs font-bold">
            Nothing charged. WinCut only earns when you exit at a profit.
          </p>
        </Card>
        <Done hash={hash} onDone={onDone} />
      </>
    );
  }

  if (lost) {
    return (
      <>
        <Card tone="white" className="p-6 text-center">
          <p className="font-display text-sm uppercase text-muted">You sold at a loss</p>
          <p className="money mt-1 text-2xl text-[#d32f45]">{usd(pnl, { sign: true })}</p>

          <div className="my-4 border-t-3 border-ink" />

          <p className="font-display text-xs uppercase">WinCut took</p>
          <p className="money animate-pop text-6xl leading-none text-[#00a152]">$0</p>

          {(credit ?? 0n) > 0n && (
            <div className="nb-sm mt-4 bg-info p-3 text-white">
              <p className="font-display text-xs uppercase">Loss credit earned</p>
              <p className="money text-xl">{usd(credit)}</p>
              <p className="mt-1 text-[10px]">Your next {usd(credit)} of profit is free.</p>
            </div>
          )}
          <p className="mt-3 text-[11px] text-muted">
            A 0.5%-of-volume app would still have charged you on this trade.
          </p>
        </Card>
        <Done hash={hash} onDone={onDone} />
      </>
    );
  }

  return (
    <>
      <Card tone="profit" className="p-6 text-center">
        <p className="font-display text-sm uppercase">You profited</p>
        <p className="money mt-1 animate-pop text-5xl leading-none">{usd(shown, { sign: true })}</p>
        <p className="mt-2 font-mono text-xs">you receive {usd((pnl ?? 0n) - (fee ?? 0n) + 0n)} of it</p>
      </Card>

      <Card className="p-4">
        <p className="mb-2 font-display text-sm uppercase">The 10% fee splits three ways</p>
        <SplitRow label="Trader you copied" value={traderCut} delay={0} share="50%" />
        <SplitRow label="Your referrer" value={referrerCut} delay={120} share="20%" />
        <SplitRow label="WinCut" value={appCut} delay={240} share="30%" />
        <div className="my-2 border-t-3 border-ink" />
        <Row label="Total fee" value={usd(fee)} strong />
        <p className="mt-2 font-mono text-[10px] text-muted">
          Each share is claimable from the hook. Nothing is pushed, so a blocked
          address can never break anyone else&apos;s trade.
        </p>
      </Card>

      <Done hash={hash} onDone={onDone} />
    </>
  );
}

function SplitRow({
  label, value, delay, share,
}: { label: string; value: bigint; delay: number; share: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <div className={`flex items-center justify-between gap-2 py-1.5 ${show ? "animate-slide" : "opacity-0"}`}>
      <span className="text-sm text-muted">
        {label} <span className="font-mono text-[10px]">{share}</span>
      </span>
      <span className="money text-base">{usd(value)}</span>
    </div>
  );
}

function Done({ hash, onDone }: { hash: string; onDone: () => void }) {
  return (
    <>
      <a
        className="nb-sm block bg-white p-3 text-center font-mono text-[10px] break-all underline"
        href={`${deployed.explorer}/tx/${hash}`}
        target="_blank"
        rel="noreferrer"
      >
        {hash}
      </a>
      <Button onClick={onDone} tone="ink" className="w-full">
        Trade again
      </Button>
    </>
  );
}

/// Counts up to the final figure in steps, for the reveal.
function useCountUp(target: bigint, ms = 700) {
  const [v, setV] = useState(0n);
  useEffect(() => {
    if (target === 0n) { setV(0n); return; }
    const steps = 18;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setV((target * BigInt(i)) / BigInt(steps));
      if (i >= steps) clearInterval(id);
    }, ms / steps);
    return () => clearInterval(id);
  }, [target, ms]);
  return v;
}
