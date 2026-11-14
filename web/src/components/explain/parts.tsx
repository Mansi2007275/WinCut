"use client";

/**
 * The pieces /how-it-works is built from.
 *
 * Same terminal vocabulary as /dashboard, and the same colour rule: green is
 * profit, red is loss, amber is a fee and nothing else, muted blue is a banked
 * credit. Nothing on this page is decorative in those colours, so a reader who
 * has seen the dashboard already knows how to read this one.
 *
 * The two interactive pieces - the calculator and the run of trades - run the
 * contract's own settlement rule rather than an illustration of it. The rule
 * is seven lines long, which is the whole point of the product, so there is no
 * excuse for a page that explains it with made-up numbers.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useInView } from "@/lib/useInView";
import { usdFromNumber } from "@/lib/format";

/** 10% of profit, after credit. Matches the contract's `fee_bps_of_profit`. */
export const FEE_PCT = 10;
/** What a conventional venue charges per side, as a fraction. */
export const CONVENTIONAL_PER_SIDE = 0.001;

/* ------------------------------------------------------------------- motion */

/** Honours the OS setting, and re-checks when the viewer changes it. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/**
 * Counts up to `value`, or simply is `value` when motion is unwelcome.
 *
 * Deliberately short: this is a number settling, not an animation to watch.
 */
export function useTick(value: number, run: boolean, ms = 550): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced || !run ? value : 0);
  const from = useRef(0);

  useEffect(() => {
    if (reduced || !run) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min((now - start) / ms, 1);
      const eased = 1 - (1 - t) ** 3;
      setShown(a + (value - a) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, run, ms, reduced]);

  return shown;
}

/* -------------------------------------------------------------------- chrome */

export function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="mono text-[12px] font-semibold tracking-wide text-secondary">
        {title.toUpperCase()}
      </h2>
      {lead && <p className="mt-1.5 text-[13px] leading-relaxed text-text">{lead}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Frame({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-card border border-border bg-surface ${className}`}>{children}</div>
  );
}

export function Stat({
  label,
  value,
  tone = "neutral",
  sub,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "profit" | "loss" | "fee" | "credit";
  sub?: string;
}) {
  const colour = {
    neutral: "var(--color-text)",
    profit: "var(--color-profit)",
    loss: "var(--color-loss)",
    fee: "var(--color-fee)",
    credit: "var(--color-credit)",
  }[tone];
  return (
    <div>
      <p className="mono text-[10px] leading-tight text-secondary">{label}</p>
      <p className="mono mt-1 text-[18px] leading-none font-semibold" style={{ color: colour }}>
        {value}
      </p>
      {sub && <p className="mono mt-1 text-[10px] leading-tight text-secondary">{sub}</p>}
    </div>
  );
}

/* --------------------------------------------------------------- calculator */

type Settled = {
  pnl: number;
  creditUsed: number;
  creditBanked: number;
  taxable: number;
  fee: number;
  toTrader: number;
  toReferrer: number;
  toProtocol: number;
};

/**
 * `math::settle_sell`, in the browser.
 *
 * Re-derived rather than quoted from the chain because this is a hypothetical
 * about a trade nobody has placed; `quote_sell_fee` is what the order panel
 * uses for a real one, and it runs this same rule inside the contract.
 */
export function settle(entry: number, exit: number, creditBefore: number): Settled {
  const pnl = exit - entry;
  if (pnl < 0) {
    return {
      pnl,
      creditUsed: 0,
      creditBanked: -pnl,
      taxable: 0,
      fee: 0,
      toTrader: 0,
      toReferrer: 0,
      toProtocol: 0,
    };
  }
  const creditUsed = Math.min(creditBefore, pnl);
  const taxable = pnl - creditUsed;
  const fee = (taxable * FEE_PCT) / 100;
  return {
    pnl,
    creditUsed,
    creditBanked: 0,
    taxable,
    fee,
    toTrader: fee * 0.5,
    toReferrer: fee * 0.2,
    toProtocol: fee * 0.3,
  };
}

export function Calculator() {
  const entry = 100;
  const [movePct, setMovePct] = useState(20);
  const [banked, setBanked] = useState(0);
  const exit = entry * (1 + movePct / 100);
  const r = useMemo(() => settle(entry, exit, banked), [exit, banked]);

  // 0.1% in and 0.1% out, charged on notional whichever way the trade went.
  const conventional = (entry + exit) * CONVENTIONAL_PER_SIDE;

  const feeShown = useTick(r.fee, true);
  const pnlShown = useTick(r.pnl, true);

  return (
    <Frame className="p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor="move" className="mono text-[11px] text-secondary">
          a {usdFromNumber(entry)} position closes at
        </label>
        <span
          className="mono text-[15px] font-semibold"
          style={{ color: movePct < 0 ? "var(--color-loss)" : "var(--color-profit)" }}
        >
          {movePct > 0 ? "+" : ""}
          {movePct}%
        </span>
        <span className="mono text-[11px] text-secondary">= {usdFromNumber(exit)}</span>
      </div>

      <input
        id="move"
        type="range"
        min={-50}
        max={50}
        step={1}
        value={movePct}
        onChange={(e) => setMovePct(Number(e.target.value))}
        className="mt-3 w-full accent-[var(--color-accent)]"
        aria-label="Exit price, as a percentage move from entry"
      />
      <div className="mono mt-1 flex justify-between text-[10px] text-secondary">
        <span>-50%</span>
        <span>0</span>
        <span>+50%</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <span className="mono text-[10px] text-secondary">loss credit already banked</span>
        {[0, 10, 25].map((v) => (
          <button
            key={v}
            onClick={() => setBanked(v)}
            className={`mono rounded-btn border px-2 py-0.5 text-[10px] ${
              banked === v
                ? "border-[var(--color-credit)] text-[var(--color-credit)]"
                : "border-border text-secondary hover:text-text"
            }`}
          >
            {usdFromNumber(v)}
          </button>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label={r.pnl < 0 ? "realised loss" : "realised profit"}
          value={usdFromNumber(pnlShown, { sign: true })}
          tone={r.pnl < 0 ? "loss" : "profit"}
        />
        <Stat
          label="WinCut fee"
          value={usdFromNumber(feeShown)}
          tone="fee"
          sub={
            r.pnl < 0
              ? "losing exit — free"
              : r.creditUsed > 0
                ? `${usdFromNumber(r.creditUsed)} of credit spent first`
                : `${FEE_PCT}% of the profit`
          }
        />
        <Stat
          label="credit banked"
          value={usdFromNumber(r.creditBanked)}
          tone="credit"
          sub={r.creditBanked > 0 ? "shelters your next win" : "nothing to bank on a win"}
        />
        <Stat
          label="a 0.1%-per-trade app"
          value={usdFromNumber(conventional)}
          tone="loss"
          sub="charged either way"
        />
      </div>

      <SplitBars fee={r.fee} />
    </Frame>
  );
}

/** The 50/20/30 split, drawn to scale and labelled with the amounts. */
export function SplitBars({ fee }: { fee: number }) {
  const parts = [
    { label: "trader", pct: 50 },
    { label: "referrer", pct: 20 },
    { label: "protocol", pct: 30 },
  ];
  const empty = fee <= 0;
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex items-baseline justify-between">
        <span className="mono text-[10px] text-secondary">where that fee goes</span>
        <span className="mono text-[10px]" style={{ color: "var(--color-fee)" }}>
          {usdFromNumber(fee)}
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        {parts.map((p) => (
          <div key={p.label} className="flex items-center gap-2">
            <span className="mono w-16 shrink-0 text-[10px] text-secondary">{p.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-pill border border-border">
              <div
                className="h-full transition-[width] duration-500"
                style={{
                  width: `${p.pct}%`,
                  background: "var(--color-fee)",
                  opacity: empty ? 0.16 : 0.85,
                }}
              />
            </div>
            <span
              className="mono w-16 shrink-0 text-right text-[10px]"
              style={{ color: empty ? "var(--color-secondary)" : "var(--color-fee)" }}
            >
              {usdFromNumber((fee * p.pct) / 100)}
            </span>
          </div>
        ))}
      </div>
      {empty && (
        <p className="mono mt-2 text-[10px] leading-relaxed text-secondary">
          No fee, so there is nothing to split. An absent trader or referrer hands their share to
          the protocol — it is never charged to you twice.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ run of trades */

const RUN = [
  { label: "trade 1", entry: 100, exit: 80 },
  { label: "trade 2", entry: 100, exit: 85 },
  { label: "trade 3", entry: 100, exit: 120 },
  { label: "trade 4", entry: 100, exit: 140 },
];

/**
 * Four trades in order, with the credit carried between them.
 *
 * The sequence is the argument: two losses cost nothing and bank $35, the
 * first win spends $20 of it and still pays nothing, and only the second win -
 * once the credit is gone - produces a fee at all. Picking a run that ends in
 * profit is deliberate; a run of losses would make the point too easily.
 */
export function TradeRun() {
  const { ref, seen } = useInView<HTMLDivElement>("-40px");
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (reduced) return setStep(RUN.length);
    setStep(0);
    const timers = RUN.map((_, i) => setTimeout(() => setStep(i + 1), 450 + i * 900));
    return () => timers.forEach(clearTimeout);
  }, [seen, reduced]);

  const rows = useMemo(() => {
    let credit = 0;
    return RUN.map((t) => {
      const r = settle(t.entry, t.exit, credit);
      const before = credit;
      credit = credit - r.creditUsed + r.creditBanked;
      return { ...t, ...r, creditBefore: before, creditAfter: credit };
    });
  }, []);

  const peak = Math.max(...rows.map((r) => r.creditAfter), 1);
  const shown = rows.slice(0, step);
  const current = shown[shown.length - 1];

  return (
    <div ref={ref}>
      <Frame className="overflow-hidden">
        <div className="border-b border-border px-3 py-2">
          <div className="flex items-baseline justify-between">
            <span className="mono text-[10px] text-secondary">loss credit</span>
            <span className="mono text-[11px] font-semibold" style={{ color: "var(--color-credit)" }}>
              {usdFromNumber(current?.creditAfter ?? 0)}
            </span>
          </div>
          <div className="mt-1.5 h-2.5 overflow-hidden rounded-pill border border-border">
            <div
              className={reduced ? "h-full" : "h-full transition-[width] duration-700 ease-out"}
              style={{
                width: `${((current?.creditAfter ?? 0) / peak) * 100}%`,
                background: "var(--color-credit)",
              }}
            />
          </div>
        </div>

        <ol>
          {rows.map((r, i) => {
            const visible = i < step;
            const loss = r.pnl < 0;
            return (
              <li
                key={r.label}
                className={`border-b border-border px-3 py-2.5 last:border-0 ${
                  reduced ? "" : "transition-opacity duration-500"
                }`}
                style={{ opacity: visible ? 1 : 0.22 }}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="mono w-14 shrink-0 text-[10px] text-secondary">{r.label}</span>
                  <span className="mono text-[11px] text-secondary">
                    {usdFromNumber(r.entry)} → {usdFromNumber(r.exit)}
                  </span>
                  <span
                    className="mono text-[12px] font-semibold"
                    style={{ color: loss ? "var(--color-loss)" : "var(--color-profit)" }}
                  >
                    {usdFromNumber(r.pnl, { sign: true })}
                  </span>
                  <span
                    className="mono ml-auto text-[12px] font-semibold"
                    style={{ color: r.fee > 0 ? "var(--color-fee)" : "var(--color-secondary)" }}
                  >
                    fee {usdFromNumber(r.fee)}
                  </span>
                </div>
                <p className="mono mt-1 text-[10px] leading-relaxed text-secondary">
                  {loss
                    ? `no fee on a losing exit · ${usdFromNumber(r.creditBanked)} banked, credit now ${usdFromNumber(r.creditAfter)}`
                    : r.creditUsed >= r.pnl
                      ? `profit fully covered by banked credit · ${usdFromNumber(r.creditUsed)} spent, credit now ${usdFromNumber(r.creditAfter)}`
                      : `credit exhausted · ${FEE_PCT}% of the remaining ${usdFromNumber(r.taxable)} = ${usdFromNumber(r.fee)}, split 50/20/30`}
                </p>
              </li>
            );
          })}
        </ol>
      </Frame>

      <p className="mono mt-2 text-[10px] leading-relaxed text-secondary">
        Four trades, $35 of losses, $60 of wins, and exactly{" "}
        <span style={{ color: "var(--color-fee)" }}>{usdFromNumber(rows[3]!.fee)}</span> charged —
        on the fourth trade, and only after the credit ran out. A venue at 0.1% per side would have
        taken {usdFromNumber(rows.reduce((s, r) => s + (r.entry + r.exit) * CONVENTIONAL_PER_SIDE, 0))}{" "}
        across the same four.
      </p>
    </div>
  );
}
