"use client";

import NumberFlow from "@number-flow/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EXPLORER_NAME, explorerAccount, explorerTx } from "@/lib/explorer";
import { shortAccount, toNumber } from "@/lib/format";
import { USDC_DECIMALS } from "@/lib/near";

/* ---------------------------------------------------------------- surfaces */

export function Card({
  children,
  className = "",
  tone = "surface",
}: {
  children: ReactNode;
  className?: string;
  /// `surface` is the default card. `elevated` is for a card sitting on top of
  /// another one. The signal tones are dim-tinted fills, never full saturation
  /// behind text.
  tone?: "surface" | "elevated" | "profit" | "loss" | "accent" | "bare";
}) {
  const tones = {
    surface: "bg-surface border border-border",
    elevated: "bg-elevated border border-border",
    profit: "bg-profit-dim border border-profit/30",
    loss: "bg-loss-dim border border-loss/30",
    accent: "bg-accent-dim border border-accent/30",
    bare: "",
  } as const;
  return <div className={`rounded-card ${tones[tone]} ${className}`}>{children}</div>;
}

/* ----------------------------------------------------------------- buttons */

export function Button({
  children,
  onClick,
  disabled,
  tone = "accent",
  className = "",
  type = "button",
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "accent" | "profit" | "loss" | "elevated" | "ghost";
  className?: string;
  type?: "button" | "submit";
  "aria-label"?: string;
}) {
  const tones = {
    accent: "bg-accent text-white hover:bg-accent/90",
    profit: "bg-profit text-[#04150E] hover:bg-profit/90",
    loss: "bg-loss text-white hover:bg-loss/90",
    elevated: "bg-elevated text-text border border-border hover:bg-elevated/70",
    ghost: "bg-transparent text-secondary hover:text-text",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`tap rounded-btn px-4 text-sm font-semibold transition-[transform,background-color,opacity] duration-150 active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

/// A small toggle: amount presets, sell percentages, timeframes.
export function Chip({
  children,
  active,
  onClick,
  className = "",
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`tap rounded-btn border px-4 text-sm font-semibold transition-[transform,background-color,border-color] duration-150 active:scale-[0.97] ${
        active
          ? "border-accent bg-accent/15 text-accent"
          : "border-border bg-elevated text-secondary hover:text-text"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------- tabs */

/// Underline tabs. Used where the set can grow past the screen edge, so the
/// strip scrolls horizontally rather than squeezing.
export function Tabs<T extends string>({
  options,
  value,
  onChange,
  className = "",
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`no-scrollbar -mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 ${className}`}
    >
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`tap relative shrink-0 px-3 text-sm font-semibold whitespace-nowrap transition-colors duration-150 ${
            value === o.id ? "text-text" : "text-secondary hover:text-text"
          }`}
        >
          {o.label}
          {value === o.id && (
            <span className="absolute inset-x-3 -bottom-px block h-0.5 rounded-full bg-text" />
          )}
        </button>
      ))}
    </div>
  );
}

/// Pill segmented control. Used for a fixed pair of views, like the two
/// leaderboard orderings.
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className = "",
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`flex gap-1 rounded-card border border-border bg-surface p-1 ${className}`}
    >
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`tap flex-1 rounded-btn px-3 text-sm font-semibold transition-colors duration-150 ${
            value === o.id ? "bg-elevated text-text" : "text-secondary hover:text-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- rows */

export function Row({
  label,
  value,
  tone = "text",
  strong,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "text" | "profit" | "loss" | "muted" | "accent";
  strong?: boolean;
}) {
  const tones = {
    text: "text-text",
    profit: "text-profit",
    loss: "text-loss",
    muted: "text-secondary",
    accent: "text-accent",
  } as const;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className={`text-sm text-secondary ${strong ? "font-semibold text-text" : ""}`}>
        {label}
      </span>
      <span className={`num ${strong ? "text-lg font-semibold" : "text-sm"} ${tones[tone]}`}>
        {value}
      </span>
    </div>
  );
}

/// The tiny grey uppercase header above a list, e.g. "COIN … PRICE".
export function ColumnHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-1 pb-2 text-[10px] font-semibold tracking-wider text-secondary uppercase">
      {children}
    </div>
  );
}

export function SectionHeading({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-base font-semibold">{children}</h2>
      {right}
    </div>
  );
}

/* ------------------------------------------------------------------ states */

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <Card className="p-5">
      <div className="shimmer mb-3 h-3 w-24 rounded" />
      <div className="shimmer mb-2 h-3 w-full rounded" />
      <div className="shimmer h-3 w-2/3 rounded" />
      <p className="mt-3 text-xs text-secondary">{label}…</p>
    </Card>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card className="p-6 text-center">
      <p className="text-sm font-semibold">{title}</p>
      {hint && <p className="mt-2 text-sm text-secondary">{hint}</p>}
    </Card>
  );
}

export function ErrorBox({ title = "Something broke", detail }: { title?: string; detail?: string }) {
  return (
    <Card tone="loss" className="p-4">
      <p className="text-sm font-semibold text-loss">{title}</p>
      {detail && <p className="mt-1.5 text-xs leading-snug break-words text-text/80">{detail}</p>}
    </Card>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "profit" | "loss" | "accent";
}) {
  const tones = {
    neutral: "bg-elevated text-secondary border-border",
    profit: "bg-profit/15 text-profit border-profit/30",
    loss: "bg-loss/15 text-loss border-loss/30",
    accent: "bg-accent/15 text-accent border-accent/30",
  } as const;
  return (
    <span
      className={`inline-block rounded-pill border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function TxState({
  status,
  hash,
  explorer,
}: {
  status: "idle" | "pending" | "confirmed" | "failed";
  hash?: string;
  explorer?: string;
}) {
  if (status === "idle") return null;
  const map = {
    pending: { tone: "accent", label: "Transaction pending" },
    confirmed: { tone: "profit", label: "Confirmed" },
    failed: { tone: "loss", label: "Failed" },
  } as const;
  const s = map[status];
  const text = { accent: "text-accent", profit: "text-profit", loss: "text-loss" }[s.tone];
  return (
    <Card tone={s.tone} className="p-3">
      <p className={`text-xs font-semibold ${text}`}>{s.label}</p>
      {hash && explorer && (
        <a
          className="mt-1 block text-[10px] break-all text-secondary underline underline-offset-2 hover:text-text"
          href={`${explorer}/tx/${hash}`}
          target="_blank"
          rel="noreferrer"
        >
          {hash}
        </a>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- avatars */

/**
 * An avatar derived from the account id itself.
 *
 * Two characters of the id over a hue hashed from the whole of it, so the same
 * account is always the same colour. Deliberately NOT a generated human name:
 * an invented handle makes a stranger's account look like something the app
 * knows about, which is a claim it cannot back.
 */
export function Avatar({
  address,
  size = 32,
  className = "",
}: {
  address?: string;
  size?: number;
  className?: string;
}) {
  const clean = (address ?? "").replace(/\.near$/, "");
  const initials = clean.slice(0, 2).toUpperCase() || "··";
  // Hue from a sum over the whole id, so `alice.near` and `alex.near` differ.
  let seed = 0;
  for (const ch of address ?? "") seed = (seed * 31 + ch.charCodeAt(0)) % 100_000;
  const hue = seed % 360;
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-pill font-semibold ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        background: `hsl(${hue} 42% 22%)`,
        color: `hsl(${hue} 70% 72%)`,
      }}
    >
      {initials}
    </span>
  );
}

/* ----------------------------------------------------------------- linking */

/**
 * An account id, always linked to NearBlocks.
 *
 * There are no display names in WinCut. A NEAR account id already reads as a
 * name, and linking it out is the form a judge can verify mid-demo.
 */
export function AddressLink({
  address,
  tight,
  label,
  className = "",
}: {
  address?: string | null;
  tight?: boolean;
  label?: string;
  className?: string;
}) {
  if (!address) return <span className="text-secondary">—</span>;
  return (
    <a
      href={explorerAccount(address)}
      target="_blank"
      rel="noreferrer"
      title={address}
      className={`text-accent underline-offset-2 hover:underline ${className}`}
    >
      {label ?? (tight ? shortAccount(address) : address)}
    </a>
  );
}

/// A transaction hash, linked. Used on every trade row and result screen.
export function TxLink({ hash, children }: { hash?: string; children?: ReactNode }) {
  if (!hash) return null;
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      className="text-[11px] text-accent underline-offset-2 hover:underline"
    >
      {children ?? `view on ${EXPLORER_NAME} ↗`}
    </a>
  );
}

/* --------------------------------------------------------------- skeletons */

/// A loading placeholder with the same box as the content it replaces, so
/// nothing shifts when the real data lands.
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`shimmer rounded ${className}`} />;
}

export function SkeletonRows({ rows = 3, height = "h-16" }: { rows?: number; height?: string }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Card key={i} className={`${height} p-3`}>
          <Skeleton className="mb-2 h-3 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
        </Card>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- stats */

export function StatTile({
  label,
  value,
  tone = "text",
  sub,
}: {
  label: string;
  value: ReactNode;
  tone?: "text" | "profit" | "loss" | "accent";
  sub?: ReactNode;
}) {
  const tones = {
    text: "text-text",
    profit: "text-profit",
    loss: "text-loss",
    accent: "text-accent",
  } as const;
  return (
    <Card className="px-3 py-2.5">
      <p className="text-[10px] font-medium tracking-wide text-secondary uppercase">{label}</p>
      <p className={`num mt-1 text-base leading-tight font-semibold ${tones[tone]}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] leading-tight text-secondary">{sub}</p>}
    </Card>
  );
}

/* ------------------------------------------------------------ live numbers */

/**
 * A number that animates between values instead of snapping.
 *
 * Every figure here is read from the chain, so it changes under the user
 * rather than because they did something. Rolling the digits shows which part
 * moved; snapping just makes the screen look like it reloaded.
 */
export function Num({
  value,
  prefix = "",
  suffix = "",
  decimals = 2,
  sign = false,
  className = "",
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  sign?: boolean;
  className?: string;
}) {
  return (
    <NumberFlow
      value={value}
      prefix={prefix}
      suffix={suffix}
      format={{
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        signDisplay: sign ? "always" : "auto",
      }}
      className={`num ${className}`}
    />
  );
}

/// The same, for a raw USDC bigint.
export function Money({
  value,
  decimals = 2,
  sign = false,
  className = "",
}: {
  value: bigint | undefined;
  decimals?: number;
  sign?: boolean;
  className?: string;
}) {
  if (value === undefined) return <span className={`num ${className}`}>—</span>;
  const n = toNumber(value, USDC_DECIMALS);
  const negative = n < 0;
  return (
    <span className={`num ${className}`}>
      {negative ? "-" : sign ? "+" : ""}
      <NumberFlow
        value={Math.abs(n)}
        prefix="$"
        format={{ minimumFractionDigits: decimals, maximumFractionDigits: decimals }}
      />
    </span>
  );
}

/**
 * Flashes a value green or red for 300ms when it moves.
 *
 * Colour only, no transform, so a list of them cannot cause layout work.
 * Returns the class to put on the element showing `value`.
 */
export function useFlash(value: number | undefined): string {
  const previous = useRef<number | undefined>(undefined);
  const [cls, setCls] = useState("");
  useEffect(() => {
    if (value === undefined) return;
    const before = previous.current;
    previous.current = value;
    if (before === undefined || before === value) return;
    setCls(value > before ? "flash-up" : "flash-down");
    const id = setTimeout(() => setCls(""), 320);
    return () => clearTimeout(id);
  }, [value]);
  return cls;
}

/**
 * Animates a bigint up to its final value.
 *
 * Steps through in integer arithmetic rather than interpolating a float, so
 * the last frame is exactly the on-chain figure. Respects reduced-motion by
 * jumping straight to the answer.
 */
export function useCountUp(target: bigint, ms = 700): bigint {
  const [v, setV] = useState(0n);
  useEffect(() => {
    if (target === 0n) {
      setV(0n);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setV(target);
      return;
    }
    const steps = 18;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setV((target * BigInt(i)) / BigInt(steps));
      if (i >= steps) {
        setV(target);
        clearInterval(id);
      }
    }, ms / steps);
    return () => clearInterval(id);
  }, [target, ms]);
  return v;
}

/* --------------------------------------------------------------- split bar */

/// The 50/20/30 fee split, drawn as one bar. The widths come from the actual
/// cut amounts in the FeeSplit event, not from the constants, so a rounding
/// remainder in the treasury share shows up rather than being hidden.
export function SplitBar({ parts }: { parts: { value: bigint; className: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0n);
  if (total === 0n) return null;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-pill bg-elevated">
      {parts.map((p, i) => (
        <div
          key={i}
          className={p.className}
          style={{ width: `${(Number(p.value) / Number(total)) * 100}%` }}
        />
      ))}
    </div>
  );
}
