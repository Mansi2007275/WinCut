"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { explorerAddr, explorerTx } from "@/lib/chain";
import { short, shorter } from "@/lib/format";

export function Card({
  children,
  className = "",
  tone = "white",
}: {
  children: ReactNode;
  className?: string;
  tone?: "white" | "brand" | "profit" | "loss" | "info";
}) {
  const tones = {
    white: "bg-white",
    brand: "bg-brand",
    profit: "bg-profit",
    loss: "bg-loss",
    info: "bg-info",
  } as const;
  return <div className={`nb ${tones[tone]} ${className}`}>{children}</div>;
}

export function Button({
  children,
  onClick,
  disabled,
  tone = "brand",
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "brand" | "profit" | "loss" | "white" | "ink";
  className?: string;
  type?: "button" | "submit";
}) {
  const tones = {
    brand: "bg-brand text-ink",
    profit: "bg-profit text-ink",
    loss: "bg-loss text-white",
    white: "bg-white text-ink",
    ink: "bg-ink text-brand",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`nb nb-press font-display uppercase tracking-tight px-4 py-3 text-base ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Chip({
  children,
  active,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`nb-sm nb-press px-3 py-2 text-sm font-bold ${active ? "bg-brand" : "bg-white"}`}
    >
      {children}
    </button>
  );
}

export function Tabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-0 border-3 border-ink shadow-[4px_4px_0_#000] bg-white">
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`flex-1 font-display uppercase text-sm py-3 ${
            value === o.id ? "bg-ink text-brand" : "bg-white text-ink"
          } ${i > 0 ? "border-l-3 border-ink" : ""}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Row({
  label,
  value,
  tone = "ink",
  strong,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "ink" | "profit" | "loss" | "muted" | "info";
  strong?: boolean;
}) {
  const tones = {
    ink: "text-ink",
    profit: "text-[#00a152]",
    loss: "text-[#d32f45]",
    muted: "text-muted",
    info: "text-[#2b55d4]",
  } as const;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className={`text-sm ${strong ? "font-bold" : ""} text-muted`}>{label}</span>
      <span className={`money ${strong ? "text-lg" : "text-sm"} ${tones[tone]}`}>{value}</span>
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="nb bg-white p-5">
      <div className="h-3 w-24 bg-ink/10 mb-3" />
      <div className="h-3 w-full striped bg-ink/5 mb-2" />
      <div className="h-3 w-2/3 striped bg-ink/5" />
      <p className="mt-3 text-xs font-bold uppercase text-muted">{label}…</p>
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="nb bg-white p-6 text-center">
      <p className="font-display text-lg uppercase">{title}</p>
      {hint && <p className="mt-2 text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function ErrorBox({ title = "Something broke", detail }: { title?: string; detail?: string }) {
  return (
    <div className="nb bg-loss p-5 text-white">
      <p className="font-display text-lg uppercase">{title}</p>
      {detail && <p className="mt-2 break-words font-mono text-xs leading-snug">{detail}</p>}
    </div>
  );
}

export function Badge({
  children,
  tone = "white",
}: {
  children: ReactNode;
  tone?: "white" | "brand" | "profit" | "loss" | "info";
}) {
  const tones = {
    white: "bg-white",
    brand: "bg-brand",
    profit: "bg-profit",
    loss: "bg-loss text-white",
    info: "bg-info text-white",
  } as const;
  return (
    <span
      className={`nb-sm inline-block px-2 py-0.5 text-[10px] font-display uppercase tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function DumperStamp() {
  return (
    <span className="tilt-stamp inline-block bg-loss px-2 py-0.5 text-[10px] font-display uppercase text-white">
      Dumper
    </span>
  );
}

/// Honesty = followers' PnL relative to the trader's own. A bar that reads at a glance.
export function HonestyBar({ score }: { score: number | null }) {
  if (score === null) {
    return <div className="h-3 w-full border-2 border-ink bg-white" />;
  }
  const clamped = Math.max(-1, Math.min(2, score));
  const fill = ((clamped + 1) / 3) * 100;
  const tone = score < 0 ? "bg-loss" : score < 0.5 ? "bg-brand" : "bg-profit";
  return (
    <div className="h-3 w-full border-2 border-ink bg-white">
      <div className={`h-full ${tone}`} style={{ width: `${fill}%` }} />
    </div>
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
    pending: { tone: "bg-info text-white", label: "Transaction pending" },
    confirmed: { tone: "bg-profit", label: "Confirmed" },
    failed: { tone: "bg-loss text-white", label: "Failed" },
  } as const;
  const s = map[status];
  return (
    <div className={`nb-sm ${s.tone} animate-slide p-3`}>
      <p className="font-display text-xs uppercase">{s.label}</p>
      {hash && explorer && (
        <a
          className="mt-1 block break-all font-mono text-[10px] underline"
          href={`${explorer}/tx/${hash}`}
          target="_blank"
          rel="noreferrer"
        >
          {hash}
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- linking

/**
 * An address, always linked to the explorer.
 *
 * There are no display names in WinCut. An invented handle makes a stranger's
 * wallet look like an account the app knows something about, which is a claim
 * the app cannot back. A short address that opens arcscan is the honest form,
 * and it is also the form a judge can verify mid-demo.
 */
export function AddressLink({
  address,
  tight,
  label,
  className = "",
}: {
  address?: string;
  tight?: boolean;
  label?: string;
  className?: string;
}) {
  if (!address) return <span className="text-muted">—</span>;
  return (
    <a
      href={explorerAddr(address)}
      target="_blank"
      rel="noreferrer"
      title={address}
      className={`font-mono underline decoration-ink/30 hover:decoration-ink ${className}`}
    >
      {label ?? (tight ? shorter(address) : short(address))}
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
      className="font-mono text-[10px] underline decoration-ink/30 hover:decoration-ink"
    >
      {children ?? "view on arcscan ↗"}
    </a>
  );
}

// -------------------------------------------------------------- skeletons

/// A loading placeholder with the same box as the content it replaces, so
/// nothing shifts when the real data lands.
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`animate-pulse bg-ink/10 ${className}`} />;
}

export function SkeletonRows({ rows = 3, height = "h-16" }: { rows?: number; height?: string }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={`nb bg-white ${height} p-3`}>
          <Skeleton className="mb-2 h-3 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ stats

export function StatTile({
  label,
  value,
  tone = "white",
  sub,
}: {
  label: string;
  value: ReactNode;
  tone?: "white" | "brand" | "profit" | "loss";
  sub?: ReactNode;
}) {
  const tones = {
    white: "bg-white",
    brand: "bg-brand",
    profit: "bg-profit",
    loss: "bg-loss text-white",
  } as const;
  return (
    <div className={`nb-sm ${tones[tone]} p-3`}>
      <p className="font-display text-[9px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="money mt-1 text-base leading-tight">{value}</p>
      {sub && <p className="mt-0.5 text-[10px] leading-tight opacity-70">{sub}</p>}
    </div>
  );
}

// --------------------------------------------------------------- count-up

/**
 * Animates a bigint up to its final value.
 *
 * Steps through in integer arithmetic rather than interpolating a float, so the
 * last frame is exactly the on-chain figure. Respects reduced-motion by jumping
 * straight to the answer.
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

// --------------------------------------------------------------- confetti

/**
 * Confetti on a profitable exit, drawn on a canvas.
 *
 * Hand-rolled rather than pulling in a library: it is thirty lines, it matches
 * the palette, and it self-destructs after one run so it cannot leak a rAF loop
 * across navigations.
 */
export function Confetti({ run }: { run: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!run) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const w = (canvas.width = canvas.offsetWidth);
    const h = (canvas.height = canvas.offsetHeight);
    const colors = ["#FFE600", "#00E676", "#4D7CFF", "#FF3D57", "#000000"];
    const bits = Array.from({ length: 70 }, () => ({
      x: Math.random() * w,
      y: -20 - Math.random() * h * 0.5,
      s: 5 + Math.random() * 7,
      vy: 1.6 + Math.random() * 2.6,
      vx: -1 + Math.random() * 2,
      rot: Math.random() * Math.PI,
      vr: -0.14 + Math.random() * 0.28,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));

    let frame = 0;
    let raf = 0;
    const tick = () => {
      frame += 1;
      ctx.clearRect(0, 0, w, h);
      for (const b of bits) {
        b.x += b.vx;
        b.y += b.vy;
        b.rot += b.vr;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.rot);
        ctx.fillStyle = b.c;
        ctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.6);
        ctx.restore();
      }
      if (frame < 150) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run]);

  if (!run) return null;
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60] h-full w-full"
    />
  );
}
