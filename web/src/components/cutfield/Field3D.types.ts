/**
 * The field's geometry, with no three.js in it.
 *
 * Split out from `Field3D.tsx` for one reason: the wrapper needs `layout` and
 * the `Hover` type to decide what to render and where to put a tooltip, and
 * importing those from the canvas component would pull three.js into the main
 * bundle for every viewer - including the ones who are about to be shown the
 * SVG instead. Keeping the maths here means the 3D chunk is loaded only when
 * it is going to be drawn.
 */

import type { SettledTrade } from "@/lib/cutfield";
import { isAgent } from "@/lib/agent";
import { isMarketMaker } from "@/lib/bots";

/** Half the field's width in world units; x runs -FLOOR_X … FLOOR_X. */
export const FLOOR_X = 9;
/** Distance between two markets' lanes. */
export const LANE_GAP = 1.5;

export type FieldDatum = {
  trade: SettledTrade;
  x: number;
  /** Lane centre for the market. */
  z: number;
  /** Signed pillar height in world units. */
  height: number;
  /** The fee, in world units, or 0 when none was charged. */
  feeHeight: number;
  /** A winning exit whose fee was covered entirely by banked credit. */
  sheltered: boolean;
  kind: "buy" | "win" | "loss";
  actor: "agent" | "maker" | "bot";
};

export type Hover = { datum: FieldDatum; screen: { x: number; y: number } } | null;

/**
 * Trades to geometry.
 *
 * Heights scale against the largest absolute P&L in the window, so the field
 * reads the same whether the day's biggest move was 0.4 or 40 tUSDC.
 *
 * The fee slice is drawn at ten times its true share of that scale. At the
 * real ratio - a tenth of a profit that is itself a fraction of the tallest
 * pillar - it would be well under one pixel, and a fee you cannot see is
 * indistinguishable from the fee-free case this page exists to show. The
 * exaggeration is in the drawing only: every number beside the field, and the
 * tooltip on the slice itself, is the charged amount.
 */
export function layout(ring: SettledTrade[], markets: string[]): FieldDatum[] {
  if (!ring.length) return [];
  const first = ring[0]!.at;
  const span = Math.max(ring[ring.length - 1]!.at - first, 1);
  const lane = new Map(markets.map((m, i) => [m, (i - (markets.length - 1) / 2) * LANE_GAP]));
  const biggest = Math.max(...ring.map((t) => Math.abs(t.pnl ?? 0)), 0.01);
  const scale = 2.4 / biggest;

  return ring.map((trade) => {
    const pnl = trade.pnl ?? 0;
    const kind: FieldDatum["kind"] =
      trade.side === "Buy" ? "buy" : trade.losingExit ? "loss" : "win";
    return {
      trade,
      x: ((trade.at - first) / span) * (FLOOR_X * 2) - FLOOR_X,
      z: lane.get(trade.symbol) ?? 0,
      height:
        kind === "buy" ? 0.16 : Math.sign(pnl || 1) * Math.max(Math.abs(pnl) * scale, 0.08),
      feeHeight: trade.fee > 0 ? Math.max(trade.fee * scale * 10, 0.1) : 0,
      sheltered: kind === "win" && trade.fee === 0 && pnl > 0,
      kind,
      actor: isAgent(trade.user) ? "agent" : isMarketMaker(trade.user) ? "maker" : "bot",
    };
  });
}
