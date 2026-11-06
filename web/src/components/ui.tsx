"use client";

import type { ReactNode } from "react";

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
