"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect, useBalance } from "wagmi";
import { short, usd } from "@/lib/format";
import { QUOTE } from "@/lib/chain";

const tabs = [
  { href: "/", label: "Trade" },
  { href: "/board", label: "Board" },
  { href: "/me", label: "Me" },
] as const;

export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t-3 border-ink bg-cream">
      <div className="mx-auto flex max-w-md">
        {tabs.map((t, i) => {
          const active = path === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`flex-1 py-4 text-center font-display text-sm uppercase ${
                active ? "bg-ink text-brand" : "bg-cream text-ink"
              } ${i > 0 ? "border-l-3 border-ink" : ""}`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function TopBar() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: bal } = useBalance({ address });

  return (
    <header className="sticky top-0 z-40 border-b-3 border-ink bg-brand">
      <div className="mx-auto flex max-w-md items-center justify-between gap-2 px-4 py-3">
        <div>
          <p className="font-display text-xl leading-none uppercase">WinCut</p>
          <p className="text-[10px] font-bold leading-tight text-ink/70">
            Paid only when you win
          </p>
        </div>

        {isConnected ? (
          <button
            onClick={() => disconnect()}
            className="nb-sm nb-press bg-white px-2 py-1 text-left"
          >
            <span className="block font-mono text-[10px] leading-tight">{short(address)}</span>
            <span className="money block text-xs leading-tight">
              {usd(bal?.value)} {QUOTE.symbol}
            </span>
          </button>
        ) : (
          <button
            onClick={() => connect({ connector: connectors[0] })}
            disabled={isPending || connectors.length === 0}
            className="nb-sm nb-press bg-ink px-3 py-2 font-display text-xs uppercase text-brand disabled:opacity-50"
          >
            {isPending ? "…" : "Connect"}
          </button>
        )}
      </div>
    </header>
  );
}

export function Page({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar />
      <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-4">{children}</main>
      <BottomNav />
    </>
  );
}
