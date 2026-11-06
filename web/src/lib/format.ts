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
  if (n < 0.0001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function pct(numerator: bigint, denominator: bigint, dp = 1): string {
  if (denominator === 0n) return "—";
  const v = (Number(numerator) / Number(denominator)) * 100;
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
}

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

/// Deterministic display handle, so the same wallet always reads the same.
export function handle(a?: string): string {
  if (!a) return "@unknown";
  const names = [
    "ace", "bolt", "cobra", "delta", "ember", "flux", "gizmo", "halo",
    "iris", "jolt", "kilo", "lumen", "mako", "nova", "onyx", "pulse",
    "quartz", "rune", "sable", "tango", "umbra", "vertex", "wisp", "xeno",
  ];
  const n = parseInt(a.slice(2, 8), 16);
  return `@${names[n % names.length]}${(n % 900) + 100}`;
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
