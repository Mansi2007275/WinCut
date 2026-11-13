/**
 * Number formatting.
 *
 * Everything on chain is a raw integer in its own number of decimals - USDC
 * has 6, wNEAR 24, LONK 8 - so every function here takes the decimals rather
 * than assuming. Nothing is ever rendered from a float that came off the wire.
 */

import { QUOTE_IS_USD, QUOTE_LABEL, USDC_DECIMALS } from "./near";

const EMPTY = "—";

/**
 * Wraps a formatted magnitude in the quote currency.
 *
 * Mainnet prices are dollars and read as `$1.23`. Testnet prices are in a test
 * token and read as `1.23 tUSDC`, because they are not dollars and must not
 * look like them - the ticker goes after the number so it cannot be mistaken
 * for a currency symbol.
 */
function money(sign: string, body: string): string {
  return QUOTE_IS_USD ? `${sign}$${body}` : `${sign}${body} ${QUOTE_LABEL}`;
}

/** Raw units to a JS number, for display and charting only. */
export function toNumber(raw: bigint | string | undefined, decimals: number): number {
  if (raw === undefined || raw === null) return NaN;
  const v = typeof raw === "bigint" ? raw : BigInt(raw || 0);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = Number(abs / base);
  const frac = Number(abs % base) / Number(base);
  return (neg ? -1 : 1) * (whole + frac);
}

/** A decimal string to raw units, truncating anything past `decimals`. */
export function toRaw(input: string, decimals: number): bigint {
  const trimmed = (input ?? "").trim();
  if (!trimmed || !/^\d*\.?\d*$/.test(trimmed)) return 0n;
  const [whole = "0", frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** USDC, as money. */
export function usd(
  raw: bigint | string | undefined,
  opts: { dp?: number; sign?: boolean } = {},
): string {
  if (raw === undefined || raw === null) return EMPTY;
  const n = toNumber(raw, USDC_DECIMALS);
  if (!Number.isFinite(n)) return EMPTY;
  return usdFromNumber(n, opts);
}

export function usdFromNumber(n: number, opts: { dp?: number; sign?: boolean } = {}): string {
  if (!Number.isFinite(n)) return EMPTY;
  const dp = opts.dp ?? (Math.abs(n) >= 1 || n === 0 ? 2 : 4);
  const sign = n < 0 ? "-" : opts.sign ? "+" : "";
  const body = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  return money(sign, body);
}

/** Big money, compacted: $1.2M. */
export function usdCompact(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return EMPTY;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return money(sign, `${(abs / 1e9).toFixed(2)}B`);
  if (abs >= 1e6) return money(sign, `${(abs / 1e6).toFixed(2)}M`);
  if (abs >= 1e3) return money(sign, `${(abs / 1e3).toFixed(1)}K`);
  return money(sign, abs.toFixed(2));
}

/** Token amounts. Memecoin balances run to the billions, so they compact. */
export function tokens(raw: bigint | string | undefined, decimals: number): string {
  if (raw === undefined || raw === null) return EMPTY;
  const n = toNumber(raw, decimals);
  if (!Number.isFinite(n)) return EMPTY;
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toFixed(4).replace(/\.?0+$/, "");
  return n.toFixed(Math.min(decimals, 8)).replace(/\.?0+$/, "");
}

/**
 * A token price in USD. Memecoins trade at 1e-9, so a fixed decimal count
 * either loses the number or pads every other one with zeros. Below 0.001 the
 * zeros are counted instead: $0.0{8}586 reads as eight zeros then 586.
 */
export function price(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n === 0) return EMPTY;
  const abs = Math.abs(n);
  if (abs >= 1000) return usdFromNumber(n, { dp: 2 });
  if (abs >= 1) return usdFromNumber(n, { dp: 4 });
  if (abs >= 0.001) return usdFromNumber(n, { dp: 6 });

  const exp = Math.floor(Math.log10(abs));
  const zeros = -exp - 1;
  const digits = Math.round(abs * 10 ** (zeros + 4)).toString().slice(0, 4);
  return money(n < 0 ? "-" : "", `0.0{${zeros}}${digits}`);
}

/** Percentages, always signed, because a change of 0.00% still has a sign. */
export function pct(n: number | undefined, dp = 2): string {
  if (n === undefined || !Number.isFinite(n)) return EMPTY;
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toFixed(dp)}%`;
}

/** A NEAR account id, shortened only when it is an implicit (64 hex) one. */
export function shortAccount(id: string | undefined | null): string {
  if (!id) return EMPTY;
  if (/^[0-9a-f]{64}$/.test(id)) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  if (id.length <= 24) return id;
  const [name, ...rest] = id.split(".");
  const suffix = rest.join(".");
  if (name.length > 14) return `${name.slice(0, 10)}…${suffix ? "." + suffix : ""}`;
  return id;
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** A nanosecond block timestamp as "3 minutes ago". */
export function ago(timestampNs: number | string | undefined): string {
  if (!timestampNs) return EMPTY;
  const ms = Number(BigInt(timestampNs) / 1_000_000n);
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return RELATIVE.format(Math.round(diff), "second");
  if (abs < 3600) return RELATIVE.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return RELATIVE.format(Math.round(diff / 3600), "hour");
  return RELATIVE.format(Math.round(diff / 86400), "day");
}

/** A nanosecond block timestamp as a clock time, for chart markers. */
export function clock(timestampNs: number | string | undefined): string {
  if (!timestampNs) return EMPTY;
  const ms = Number(BigInt(timestampNs) / 1_000_000n);
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

/** Signed USDC as the contract reports it: a flag plus a magnitude. */
export type SignedUsdc = { negative: boolean; abs: string };

export function signedUsd(v: SignedUsdc | undefined | null, opts: { sign?: boolean } = {}): string {
  if (!v) return EMPTY;
  const n = toNumber(v.abs, USDC_DECIMALS) * (v.negative ? -1 : 1);
  return usdFromNumber(n, { sign: opts.sign ?? true });
}

export function signedNumber(v: SignedUsdc | undefined | null): number {
  if (!v) return 0;
  return toNumber(v.abs, USDC_DECIMALS) * (v.negative ? -1 : 1);
}

/** Tailwind class for a signal colour: profit, loss, or neither. */
export function signalClass(n: number): string {
  if (n > 0) return "text-profit";
  if (n < 0) return "text-loss";
  return "text-secondary";
}

export { EMPTY };
