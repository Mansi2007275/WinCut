import { formatUnits } from "viem";
import { QUOTE } from "./chain";

/// Money, always in QUOTE units (native USDC, 18 decimals on Arc).
export function usd(v: bigint | undefined, opts?: { decimals?: number; sign?: boolean }): string {
  if (v === undefined) return "—";
  const dp = opts?.decimals ?? 2;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const n = Number(formatUnits(abs, QUOTE.decimals));
  const body = n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const sign = neg ? "-" : opts?.sign ? "+" : "";
  return `${sign}$${body}`;
}

/// Coin amounts: large numbers, so compact them.
export function coins(v: bigint | undefined, decimals = 18): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, decimals));
  if (n === 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  // No scientific notation anywhere in the UI, dust amounts included.
  if (n < 0.0001) return n.toLocaleString("en-US", { maximumFractionDigits: 10 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function pct(numerator: bigint, denominator: bigint, dp = 1): string {
  if (denominator === 0n) return "—";
  const v = (Number(numerator) / Number(denominator)) * 100;
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
}

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

/// Tighter form, for table cells at 390px.
export const shorter = (a?: string) => (a ? `${a.slice(0, 4)}…${a.slice(-3)}` : "—");

/// Relative time for the feed. Arc blocks are ~1s, which is close enough to
/// read a block delta as seconds without fetching every block's timestamp.
export function ago(block: bigint, head?: bigint): string {
  if (head === undefined || head < block) return "now";
  const s = Number(head - block);
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Price of one coin in QUOTE, from the pool's sqrtPriceX96.
 *
 * price = (sqrtPriceX96 / 2^96)^2 gives currency1 per currency0. Native USDC is
 * address(0) so it always sorts to currency0, and both sides carry 18 decimals,
 * so no decimal correction is needed. Returned as a JS number because it only
 * ever feeds a chart axis and a label, never an amount we send on chain.
 */
export function priceFromSqrtX96(sqrtPriceX96: bigint, quoteIsCurrency0: boolean): number {
  if (sqrtPriceX96 === 0n) return 0;
  const r = Number(sqrtPriceX96) / 2 ** 96;
  const onePerZero = r * r;
  if (!Number.isFinite(onePerZero) || onePerZero === 0) return 0;
  // We want QUOTE per coin. When QUOTE is currency0 the coin is currency1, and
  // the ratio above reads as coins per dollar, so invert it.
  return quoteIsCurrency0 ? 1 / onePerZero : onePerZero;
}

const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

/// 8 -> "₈", 11 -> "₁₁".
function subscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPT_DIGITS[Number(d)])
    .join("");
}

/**
 * Coin prices, which on a freshly launched memecoin are very small numbers.
 *
 * `toExponential` was honest but unreadable: "$7.57e-9" is the kind of thing a
 * person has to stop and decode, and two of them side by side cannot be
 * compared at a glance. The convention every exchange settled on is the
 * subscript-zero form -- $0.0₈757 means "0." then eight zeros then 757 -- which
 * keeps every digit and still reads as a price.
 *
 * Normal prices get 2-4 decimals and no cleverness.
 */
export function price(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "—";
  const neg = v < 0;
  const a = Math.abs(v);
  const sign = neg ? "-" : "";

  // The cut-off is a cent, not 0.0001, because 4 decimals cannot carry a price
  // below that without losing digits: 0.00012345 would render "$0.0001" and
  // throw away everything that distinguishes it from 0.00010001.
  if (a >= 0.01) {
    return `${sign}$${a.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    })}`;
  }

  // Below a cent the leading zeros are the whole story, so count them rather
  // than print them. Deriving the exponent from toExponential's own output
  // keeps the rounding consistent: 9.999e-9 becomes 1.00e-8, and the exponent
  // we read back is the rounded one, not the original.
  const [mantissa, exponent] = a.toExponential(2).split("e");
  const zeros = -Number(exponent) - 1;
  const significant = mantissa.replace(".", "").replace(/0+$/, "") || "0";
  return `${sign}$0.0${subscript(zeros)}${significant}`;
}

/// Percent change between two prices. null when there is nothing to compare to.
export function changePct(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

/// Parses a user-typed dollar amount into QUOTE base units.
export function parseUsd(input: string): bigint {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (!cleaned || cleaned === ".") return 0n;
  const [whole, frac = ""] = cleaned.split(".");
  const padded = (frac + "0".repeat(QUOTE.decimals)).slice(0, QUOTE.decimals);
  try {
    return BigInt(whole || "0") * 10n ** BigInt(QUOTE.decimals) + BigInt(padded || "0");
  } catch {
    return 0n;
  }
}

export const BPS = 10_000n;
/// minOut is derived from netOut, NEVER from the gross quote.
export const applySlippage = (netOut: bigint, slippageBps: number) =>
  (netOut * (BPS - BigInt(slippageBps))) / BPS;
