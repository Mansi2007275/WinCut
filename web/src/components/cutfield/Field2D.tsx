"use client";

/**
 * The same field, flat.
 *
 * Shown when motion is unwelcome, WebGL is unavailable, or the viewport is a
 * phone - and it is not a consolation prize. Every claim the 3D scene makes is
 * here: a winning exit above the line, a losing one below it with no fee, an
 * amber cap when a fee was charged and a blue one when credit covered it. What
 * it loses is the fee's journey to the three posts, which is why the panel
 * underneath states the split in numbers either way.
 *
 * One `<svg>`, one row per market, no animation, no dependencies.
 */

import { useId, useMemo, useState } from "react";

import type { SettledTrade } from "@/lib/cutfield";
import { isAgent } from "@/lib/agent";
import { usdFromNumber } from "@/lib/format";
import { explorerAccount } from "@/lib/explorer";

const W = 1000;
const ROW_H = 92;
const PAD_X = 56;

export function Field2D({
  ring,
  markets,
}: {
  ring: SettledTrade[];
  markets: string[];
}) {
  const clip = useId();
  const [hover, setHover] = useState<SettledTrade | null>(null);
  const height = Math.max(markets.length, 1) * ROW_H + 24;

  const geometry = useMemo(() => {
    if (!ring.length) return [];
    const first = ring[0]!.at;
    const span = Math.max(ring[ring.length - 1]!.at - first, 1);
    const biggest = Math.max(...ring.map((t) => Math.abs(t.pnl ?? 0)), 0.01);
    const half = ROW_H / 2 - 14;

    return ring.map((t) => {
      const row = Math.max(markets.indexOf(t.symbol), 0);
      const base = 12 + row * ROW_H + ROW_H / 2;
      const x = PAD_X + ((t.at - first) / span) * (W - PAD_X * 2);
      const pnl = t.pnl ?? 0;
      const h =
        t.side === "Buy" ? 4 : Math.max((Math.abs(pnl) / biggest) * half, 2);
      return { t, x, base, h, up: pnl >= 0, row };
    });
  }, [ring, markets]);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="block w-full"
        style={{ height: `${Math.min(height, 420)}px` }}
        role="img"
        aria-label={`${ring.length} settled trades across ${markets.length} markets: winning exits above each market's line, losing exits below it`}
      >
        <defs>
          <clipPath id={clip}>
            <rect x="0" y="0" width={W} height={height} />
          </clipPath>
        </defs>

        {markets.map((m, row) => {
          const base = 12 + row * ROW_H + ROW_H / 2;
          return (
            <g key={m}>
              <line
                x1={PAD_X}
                x2={W - 8}
                y1={base}
                y2={base}
                stroke="var(--color-border)"
                strokeWidth="1"
              />
              <text
                x="8"
                y={base + 4}
                className="mono"
                fontSize="11"
                fill="var(--color-secondary)"
              >
                {m}
              </text>
            </g>
          );
        })}

        <g clipPath={`url(#${clip})`}>
          {geometry.map(({ t, x, base, h, up }) => {
            const y = up ? base - h : base;
            const colour =
              t.side === "Buy"
                ? "#3a424c"
                : t.losingExit
                  ? "var(--color-loss)"
                  : "var(--color-profit)";
            return (
              <g
                key={t.id}
                onMouseEnter={() => setHover(t)}
                onMouseLeave={() => setHover(null)}
              >
                {/* The loss haze: a banked credit, under the pillar. */}
                {t.losingExit && (
                  <rect
                    x={x - 3}
                    y={base + h}
                    width="6"
                    height="7"
                    fill="var(--color-credit)"
                    opacity="0.3"
                  />
                )}
                <rect
                  x={x - (t.side === "Buy" ? 0.9 : 1.8)}
                  y={y}
                  width={t.side === "Buy" ? 1.8 : 3.6}
                  height={h}
                  fill={colour}
                />
                {/* A fee that was charged, and a fee that credit covered. */}
                {t.fee > 0 && (
                  <rect x={x - 2.4} y={base - h - 4} width="4.8" height="3.5" fill="var(--color-fee)" />
                )}
                {t.winningExit && t.fee === 0 && (
                  <rect
                    x={x - 2.4}
                    y={base - h - 3.5}
                    width="4.8"
                    height="2.5"
                    fill="var(--color-credit)"
                  />
                )}
                {isAgent(t.user) && t.side === "Sell" && (
                  <rect
                    x={x - 2.5}
                    y={(up ? base - h - 9 : base + h + 4) - 0.5}
                    width="5"
                    height="5"
                    fill="var(--color-text)"
                  />
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {hover && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-card border border-border bg-bg/95 px-2.5 py-2">
          <TradeFacts trade={hover} />
        </div>
      )}
    </div>
  );
}

/** The tooltip body, shared with the 3D scene so both say the same thing. */
export function TradeFacts({ trade }: { trade: SettledTrade }) {
  const pnl = trade.pnl;
  return (
    <div className="mono text-[11px] leading-relaxed">
      <div className="flex items-center gap-2">
        <span className={trade.side === "Buy" ? "text-secondary" : trade.losingExit ? "text-loss" : "text-profit"}>
          {trade.side === "Buy" ? "BUY" : trade.losingExit ? "SELL · loss" : "SELL · profit"}
        </span>
        <span className="text-text">{trade.symbol}</span>
        <span className="text-secondary">#{trade.id}</span>
      </div>
      <div className="mt-1 text-secondary">
        {trade.side === "Buy" ? "spent" : "proceeds"}{" "}
        <span className="text-text">{usdFromNumber(trade.usdc)}</span>
      </div>
      {pnl !== null && (
        <div className="text-secondary">
          realised <span className={pnl < 0 ? "text-loss" : "text-profit"}>{usdFromNumber(pnl, { sign: true })}</span>
        </div>
      )}
      {trade.side === "Sell" && (
        <div className="text-secondary">
          fee{" "}
          {trade.fee > 0 ? (
            <span style={{ color: "var(--color-fee)" }}>{usdFromNumber(trade.fee)}</span>
          ) : trade.losingExit ? (
            <span className="text-profit">0 — losing exit</span>
          ) : (
            <span style={{ color: "var(--color-credit)" }}>0 — covered by banked credit</span>
          )}
        </div>
      )}
      <div className="mt-1 truncate text-secondary">{trade.user}</div>
      <div className="truncate text-[10px] text-accent">{explorerAccount(trade.user)}</div>
    </div>
  );
}
